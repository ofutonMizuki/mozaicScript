# 📄 mozaicScript GPU IR 仕様書 (GPU IR Specification)

## 1. 凡例および適合性

- 本仕様書は GPU カーネルのプラットフォーム中立な中間表現 (Intermediate Representation, **GPU IR**) を定義する。
- mozaicScript コンパイラのフロントエンドは、`gpu` 修飾子付き関数（言語仕様書 §14）を CPU 側 IR ではなく **本 IR** に lower する。
- WGSL / SPIR-V / CUDA PTX / Metal MSL などの実 GPU バックエンドは、本 IR を入力として最終形式を生成する。
- 本仕様の準拠は GPU バックエンドに対してのみ要求される。CPU 専用バックエンドは本 IR を生成・消費する必要はない（**OPTIONAL**）。
- キーワードの解釈は IETF RFC 2119 に従う。

---

## 2. ファイル形式

GPU IR は JSON 形式で表現される。コンパイラは `.gpu.json` 拡張子で 1 つのソースファイルにつき 1 つの GPU IR ファイルを出力する。例: `vecadd.moz` → `vecadd.gpu.json`。

ファイル全体は次のトップレベル構造を持つ。

```json
{
    "mozaicScriptGpu": "1.0",
    "kernels": [ <GpuKernelIR>, ... ]
}
```

| フィールド | 型 | 説明 |
|------------|----|------|
| `mozaicScriptGpu` | string | 本仕様書のバージョン番号（現行 `"1.0"`） |
| `kernels` | `GpuKernelIR[]` | 当該ファイルに含まれる全 GPU カーネルの IR |

ソース中に `gpu` 関数が存在しない場合、コンパイラは `.gpu.json` ファイルを生成しない（**MUST NOT**）。

---

## 3. カーネルノード (`GpuKernelIR`)

```json
{
    "name": "vecAdd",
    "workgroupSize": [64, 1, 1],
    "params": [
        { "name": "out", "type": "ptr<f32>", "binding": 0 },
        { "name": "a",   "type": "ptr<f32>", "binding": 1 },
        { "name": "b",   "type": "ptr<f32>", "binding": 2 },
        { "name": "n",   "type": "u32",      "binding": 3 }
    ],
    "locals": [
        { "name": "i", "type": "u32" }
    ],
    "body": [ <GpuStmt>, ... ]
}
```

| フィールド | 型 | 説明 |
|------------|-----|------|
| `name` | string | カーネル関数名（フロントエンドの関数名と一致） |
| `workgroupSize` | `[u32, u32, u32]` | `gpu(workgroupSize=...)` で宣言された X/Y/Z 次元値。1 次元のみ指定された場合 Y/Z は `1` |
| `params` | `GpuParam[]` | カーネル引数。順序はソース上の宣言順と一致 |
| `locals` | `GpuLocal[]` | 関数内ローカル変数の集合（事前宣言）。`GpuVarDecl` ノードと整合 |
| `body` | `GpuStmt[]` | 関数本体の文の列 |

### 3.1 `GpuParam`

| フィールド | 型 | 説明 |
|------------|-----|------|
| `name` | string | 引数名 |
| `type` | `GpuType` | 引数の型 |
| `binding` | u32 | バックエンドが割り当てる論理バインディングインデックス（WGSL の `@binding(n)`、SPIR-V の descriptor binding に対応）。ポインタ型は `storage_buffer`、スカラー型は `uniform` バインディングとして lower される |

`binding` 値はカーネル内でユニーク。コンパイラは順序 0, 1, 2, ... を割り当てる（**SHOULD**）。

### 3.2 `GpuLocal`

`GpuVarDecl` で導入される全ローカル変数を事前に列挙する。バックエンド（特に SPIR-V）が変数領域を関数先頭で確保するために使用する。

| フィールド | 型 | 説明 |
|------------|-----|------|
| `name` | string | 変数名 |
| `type` | `GpuType` | 変数の型 |

---

## 4. 型 (`GpuType`)

GPU IR で使用可能な型は限定される。型はすべて文字列で表現する。

| 型タグ | 説明 | 対応する CPU 側型 |
|--------|------|-----------------|
| `"i32"` / `"u32"` / `"i64"` / `"u64"` | 整数 | 同名 |
| `"f32"` / `"f64"` | 浮動小数点 | 同名 |
| `"bool"` | 真偽値 | `boolean` |
| `"ptr<T>"` | グローバルメモリ上の T 要素列への参照（`T` は上記スカラー型または `"struct:Name"`） | `Ptr<T>` |
| `"vec<T,N>"` | N 要素ベクトル（`N` は 2/3/4、`T` は `i32`/`u32`/`f32`） | 内部利用のみ |
| `"array<T,N>"` | 固定長 N 要素配列（N はコンパイル時定数） | 同名 |
| `"struct:Name"` | ユーザ定義 plain class | 同名 |

ジェネリック型・参照型・ボックス化された wrapper 型は本 IR には現れない（**MUST NOT**）。コンパイラは `i32` などの wrapper クラスを対応する `"i32"` スカラーへ事前に unbox する（**MUST**）。

ユーザ定義の plain class は別途 `structs` セクションで定義することができる（将来拡張、本バージョンではトップレベルにフィールドベタ書きを推奨）。

---

## 5. 文 (`GpuStmt`)

すべての文は `type` フィールドで判別される判別共用体である。

### 5.1 `GpuVarDecl`

ローカル変数の初期化を伴う宣言。型は事前に `kernel.locals` で宣言済みでなければならない。

```json
{ "type": "GpuVarDecl", "name": "i", "value": <GpuExpr> }
```

### 5.2 `GpuAssign`

代入。

```json
{ "type": "GpuAssign", "target": <GpuLValue>, "value": <GpuExpr> }
```

`GpuLValue` は次のいずれか。

- `{ "type": "GpuIdent", "name": "i" }`
- `{ "type": "GpuIndex", "base": <GpuExpr>, "index": <GpuExpr> }` — `ptr<T>` または `array<T,N>` に対する要素書き込み
- `{ "type": "GpuField", "base": <GpuExpr>, "field": "x" }` — struct/vec フィールド書き込み

### 5.3 `GpuIf`

```json
{
    "type": "GpuIf",
    "cond": <GpuExpr>,
    "then": [ <GpuStmt>, ... ],
    "else": [ <GpuStmt>, ... ]   // オプショナル
}
```

### 5.4 `GpuFor`

```json
{
    "type": "GpuFor",
    "init": <GpuStmt>,           // 通常 GpuVarDecl
    "cond": <GpuExpr>,
    "update": <GpuStmt>,         // 通常 GpuAssign
    "body": [ <GpuStmt>, ... ]
}
```

### 5.5 `GpuWhile`

```json
{
    "type": "GpuWhile",
    "cond": <GpuExpr>,
    "body": [ <GpuStmt>, ... ]
}
```

### 5.6 `GpuBreak`

```json
{ "type": "GpuBreak" }
```

### 5.7 `GpuReturn`

GPU カーネルの戻り値型は常に `void`（言語仕様書 §14.5）なので、`GpuReturn` は値を持たない。

```json
{ "type": "GpuReturn" }
```

### 5.8 `GpuExprStmt`

副作用のための式（主に組み込み命令の void 呼び出し）。

```json
{ "type": "GpuExprStmt", "expr": <GpuExpr> }
```

---

## 6. 式 (`GpuExpr`)

### 6.1 `GpuLiteral`

```json
{ "type": "GpuLiteral", "valueType": "u32", "value": 42 }
{ "type": "GpuLiteral", "valueType": "f32", "value": 3.14 }
{ "type": "GpuLiteral", "valueType": "bool", "value": true }
```

`valueType` は §4 のスカラー型のいずれか。`value` は JSON 数値（整数または浮動小数点）または真偽値。

### 6.2 `GpuIdent`

```json
{ "type": "GpuIdent", "name": "i", "resolvedType": "u32" }
```

参照する識別子はパラメータかローカル変数のみ。

### 6.3 `GpuBinOp`

```json
{ "type": "GpuBinOp", "op": "+", "lhs": <GpuExpr>, "rhs": <GpuExpr>, "resolvedType": "f32" }
```

| `op` | 説明 |
|------|------|
| `+`, `-`, `*`, `/`, `%` | 算術 |
| `==`, `!=`, `<`, `<=`, `>`, `>=` | 比較 → `bool` |
| `&&`, `\|\|` | 論理 → `bool` |
| `&`, `\|`, `^`, `<<`, `>>` | ビット演算（整数のみ） |

両辺の型は一致しなければならない（**MUST**）。暗黙の型変換はない。

### 6.4 `GpuUnaryOp`

```json
{ "type": "GpuUnaryOp", "op": "-", "expr": <GpuExpr>, "resolvedType": "f32" }
```

`op` は `-`（符号反転）または `!`（論理否定）。

### 6.5 `GpuIndex`

`ptr<T>` または `array<T,N>` への読み出し。

```json
{ "type": "GpuIndex", "base": <GpuExpr>, "index": <GpuExpr>, "resolvedType": "f32" }
```

### 6.6 `GpuField`

struct/vec フィールド読み出し。

```json
{ "type": "GpuField", "base": <GpuExpr>, "field": "x", "resolvedType": "f32" }
```

### 6.7 `GpuCallBuiltin`

GPU 組み込み命令の呼び出し。本 IR で許される唯一の関数呼び出しである（**MUST NOT** 任意の `gpu` 関数を呼び出すノードは定義しない。本バージョンでは GPU 関数間呼び出しは未対応とし、フロントエンドがインライン展開する **MUST**）。

```json
{
    "type": "GpuCallBuiltin",
    "name": "gpuGlobalId",
    "args": [ <GpuExpr>, ... ],
    "resolvedType": "u32"
}
```

`name` の取りうる値は §7。

---

## 7. GPU 組み込み命令一覧

言語仕様書 §14.4 で公開される組み込み関数は、本 IR では `GpuCallBuiltin.name` として次の文字列値に lower される。

### 7.1 スレッド ID / ワークグループ情報

| `name` | 戻り型 | WGSL 対応 | SPIR-V 対応 |
|--------|--------|-----------|-------------|
| `"gpuGlobalIdX"` / `"gpuGlobalIdY"` / `"gpuGlobalIdZ"` | u32 | `@builtin(global_invocation_id).{x,y,z}` | `GlobalInvocationId.{x,y,z}` |
| `"gpuGlobalId"` | u32 | `gpuGlobalIdX` の別名 | 同左 |
| `"gpuLocalIdX"` / `"gpuLocalIdY"` / `"gpuLocalIdZ"` | u32 | `@builtin(local_invocation_id).{x,y,z}` | `LocalInvocationId.{x,y,z}` |
| `"gpuLocalId"` | u32 | `gpuLocalIdX` の別名 | 同左 |
| `"gpuWorkgroupIdX"` / `"gpuWorkgroupIdY"` / `"gpuWorkgroupIdZ"` | u32 | `@builtin(workgroup_id).{x,y,z}` | `WorkgroupId.{x,y,z}` |
| `"gpuWorkgroupId"` | u32 | `gpuWorkgroupIdX` の別名 | 同左 |
| `"gpuWorkgroupSize"` | u32 | コンパイル時定数として埋め込み | 同左 |

### 7.2 バリア

| `name` | 戻り型 | WGSL 対応 | SPIR-V 対応 |
|--------|--------|-----------|-------------|
| `"gpuBarrier"` | void | `workgroupBarrier()` | `OpControlBarrier(Workgroup, Workgroup, AcquireRelease\|WorkgroupMemory)` |
| `"gpuStorageBarrier"` | void | `storageBarrier()` | `OpControlBarrier(Workgroup, Workgroup, AcquireRelease\|UniformMemory)` |

### 7.3 アトミック操作

| `name` | 引数 | 戻り型 | WGSL 対応 |
|--------|------|--------|-----------|
| `"gpuAtomicAdd"` | `ptr<u32>, u32` | u32 | `atomicAdd()` |
| `"gpuAtomicSub"` | `ptr<u32>, u32` | u32 | `atomicSub()` |
| `"gpuAtomicMin"` | `ptr<u32>, u32` | u32 | `atomicMin()` |
| `"gpuAtomicMax"` | `ptr<u32>, u32` | u32 | `atomicMax()` |
| `"gpuAtomicCas"` | `ptr<u32>, u32, u32` | u32 | `atomicCompareExchangeWeak()` の `old_value` を返す |
| `"gpuAtomicLoad"` | `ptr<u32>` | u32 | `atomicLoad()` |
| `"gpuAtomicStore"` | `ptr<u32>, u32` | void | `atomicStore()` |

i32 版は名前末尾に `"I32"` を付与する（例: `"gpuAtomicAddI32"`）。

### 7.4 数値ユーティリティ

| `name` | 引数 | 戻り型 | WGSL 対応 |
|--------|------|--------|-----------|
| `"gpuFma"` | `f32, f32, f32` | f32 | `fma()` |
| `"gpuDotF32x4"` | `ptr<f32>, ptr<f32>` | f32 | `dot(vec4<f32>, vec4<f32>)`（バックエンドがロードして合成） |

---

## 8. ホスト連携

GPU IR ファイルとは別に、CPU 側 IR（`.ast.json`）には以下のノード／組み込みが現れる。

| CPU 側 IR ノード/組み込み | 説明 |
|------------------------|------|
| `Intrinsic { name: "__builtin_gpu_dispatch", args: [kernelHandle, argsHandle, gridX, gridY, gridZ] }` | コアライブラリ `gpuDispatch()` の lower 形式 |
| `Intrinsic { name: "__builtin_gpu_sync" }` | コアライブラリ `gpuSync()` の lower 形式 |
| `Intrinsic { name: "__builtin_gpu_flush" }` | コアライブラリ `gpuFlush()` の lower 形式 |
| `Intrinsic { name: "__builtin_gpu_kernel_handle", args: ["vecAdd"] }` | カーネル名から `GpuKernel` の内部ハンドルを取得する。フロントエンドが `vecAdd` 識別子（自動生成された `GpuKernel` 定数）参照箇所に挿入する |

各 GPU バックエンドは `.gpu.json` を実 GPU 形式（`.wgsl` / `.spv` / `.cu` / `.metal` …）に変換し、ランタイム側で `__builtin_gpu_dispatch` 受領時にそれをロード・ディスパッチする。

---

## 9. バージョニング

本仕様書のメジャー番号変更時は IR の構造変更を伴う（**MAY** 後方非互換）。マイナー番号変更時は後方互換を維持する（**MUST**）。コンパイラは `mozaicScriptGpu` フィールドのバージョン文字列を必ず出力すること（**MUST**）。
