# 📄 mozaicScript 中間表現仕様書 (IR Specification)

本仕様書は mozaicScript 言語仕様書に基づき、フロントエンドが出力するJSON形式の中間表現（AST）の仕様を定義する。

---

## 1. 基本方針

- フォーマット：JSON
- 演算子オーバーロード・`if`/`while`/`<=`/`>=` の脱糖済み
- 型チェック済み（すべての式ノードに `resolvedType` を付与）
- バックエンドはこのJSONのみをインプットとして動作しなければならない（**MUST**）
- バックエンドは `resolvedType` を信頼してよく、独自に型推論を行う必要はない

---

## 2. トップレベル構造

```json
{
    "mozaicScript": "0.2.3",
    "nodes": [...]
}
```

---

## 3. ノード一覧

| カテゴリ | ノード種別 |
|----------|-----------|
| 宣言 | `ImportDecl`, `ClassDecl`, `FunctionDecl`, `VarDecl`, `TypeAliasDecl` |
| 式 | `MethodCall`, `NewExpr`, `Identifier`, `Intrinsic`, `Assign`, `MemberAccess`, `BorrowExpr` |
| 文 | `IfStmt`, `ElseStmt`, `WhileStmt`, `ForStmt`, `ReturnStmt`, `BreakStmt`, `BlockStmt` |
| リテラル | `RawLiteral` |

`BorrowExpr` および `FunctionDecl.isMut` フィールドは所有権・借用システムで導入された（**MUST**）。詳細仕様は言語仕様書 §4.9/4.10 を参照。

> スレッド/ミューテックス/条件変数/アトミックなどの並行プリミティブは専用の IR ノードを持たず、コアライブラリ (`.moc`) のクラスメソッド経由で `Intrinsic`（`__builtin_thread_*`, `__builtin_mutex_*`, `__builtin_condvar_*`, `__builtin_atomic_*32/64`, `__builtin_atomic_fence`）として出力される。各バックエンドはこれら `Intrinsic` をネイティブ同期プリミティブに lower する。

---

## 4. 共通ルール

- すべてのノードは `type` フィールドを持つ（**MUST**）
- 式ノードはすべて `resolvedType` フィールドを持つ（**MUST**）
- `resolvedType` の値はジェネリクス単一化済みの完全な型名とする（例：`Result<i32>`）
- `ImportDecl` ノードはASTの先頭にのみ出現する（**MUST**）

---

## 5. ノード定義

### ImportDecl

```json
// import "./core.moc" as *;
{ "type": "ImportDecl", "path": "./core.moc", "namespace": null }

// import "./math.moz" as Math;
{ "type": "ImportDecl", "path": "./math.moz", "namespace": "Math" }
```

- `namespace` が `null` の場合は `as *`（グローバル展開）を意味する

### TypeAliasDecl

```json
// type char = u32;
{
    "type": "TypeAliasDecl",
    "name": "char",
    "resolvedType": "u32"
}
```

### VarDecl

`const` と `let` の区別はフロントエンドの責務であり、ASTには存在しない。どちらも `VarDecl` として出力される。

```json
{
    "type": "VarDecl",
    "name": "a",
    "resolvedType": "i32",
    "value": {
        "type": "NewExpr",
        "resolvedType": "i32",
        "args": [{ "type": "RawLiteral", "kind": "int", "value": 10 }]
    }
}
```

### ClassDecl

```json
{
    "type": "ClassDecl",
    "name": "i32",
    "access": "public",
    "typeParams": [],
    "members": [{
        "type": "FieldDecl",
        "name": "bits",
        "access": "private",
        "resolvedType": "_m32"
    }],
    "methods": [{
        "type": "FunctionDecl",
        "name": "operator+",
        "access": "public",
        "params": [{ "name": "other", "resolvedType": "i32" }],
        "returnType": "i32",
        "body": [...]
    }]
}
```

### FunctionDecl

```json
{
    "type": "FunctionDecl",
    "name": "divide",
    "access": "public",
    "isMut": false,
    "typeParams": [],
    "params": [
        { "name": "a", "resolvedType": "i32" },
        { "name": "b", "resolvedType": "i32" }
    ],
    "returnType": "Result<i32>",
    "body": [...]
}
```

`isMut`（boolean、**MUST**）は所有権・借用システムで導入されたフィールド。`mut` 修飾子が付与されたメソッドおよび関数では `true`、それ以外は `false`。言語仕様書 §5.3 および §6.6 を参照。

### MethodCall（演算子オーバーロード脱糖済み）

```json
{
    "type": "MethodCall",
    "resolvedType": "i32",
    "receiver": { "type": "Identifier", "name": "a", "resolvedType": "i32" },
    "method": "operator+",
    "args": [{ "type": "Identifier", "name": "b", "resolvedType": "i32" }]
}
```

### NewExpr

```json
{
    "type": "NewExpr",
    "resolvedType": "Array<i32>",
    "args": [{ "type": "Identifier", "name": "size", "resolvedType": "i32" }]
}
```

### Assign

```json
{
    "type": "Assign",
    "target": { "type": "Identifier", "name": "a", "resolvedType": "i32" },
    "value": {
        "type": "NewExpr",
        "resolvedType": "i32",
        "args": [{ "type": "RawLiteral", "kind": "int", "value": 10 }]
    }
}
```

### Intrinsic

通常の組み込み命令：

```json
{
    "type": "Intrinsic",
    "name": "__builtin_i32_add",
    "resolvedType": "_m32",
    "args": [
        { "type": "Identifier", "name": "a", "resolvedType": "_m32" },
        { "type": "Identifier", "name": "b", "resolvedType": "_m32" }
    ]
}
```

`__builtin_sizeof` は `targetType` フィールドに単一化済みの具体的な型名を持つ。

```json
{
    "type": "Intrinsic",
    "name": "__builtin_sizeof",
    "resolvedType": "_m32",
    "targetType": "i32",
    "args": []
}
```

### IfStmt（`__builtin_if` 脱糖済み）

```json
{
    "type": "IfStmt",
    "cond": {
        "type": "Intrinsic",
        "name": "__builtin_if",
        "resolvedType": "_m32",
        "args": [{
            "type": "MethodCall",
            "resolvedType": "boolean",
            "receiver": { "type": "Identifier", "name": "a", "resolvedType": "i32" },
            "method": "operator==",
            "args": [{ "type": "Identifier", "name": "b", "resolvedType": "i32" }]
        }]
    },
    "body": [...]
}
```

### WhileStmt（`__builtin_while` 脱糖済み）

```json
{
    "type": "WhileStmt",
    "cond": {
        "type": "Intrinsic",
        "name": "__builtin_while",
        "resolvedType": "_m32",
        "args": [{
            "type": "MethodCall",
            "resolvedType": "boolean",
            "receiver": { "type": "Identifier", "name": "i", "resolvedType": "i32" },
            "method": "operator<",
            "args": [{ "type": "Identifier", "name": "len", "resolvedType": "i32" }]
        }]
    },
    "body": [...]
}
```

### ForStmt（`init` / `cond` / `update` / `body` に分解）

```json
{
    "type": "ForStmt",
    "init": {
        "type": "VarDecl",
        "name": "i",
        "resolvedType": "i32",
        "value": {
            "type": "NewExpr",
            "resolvedType": "i32",
            "args": [{ "type": "RawLiteral", "kind": "int", "value": 0 }]
        }
    },
    "cond": {
        "type": "Intrinsic",
        "name": "__builtin_if",
        "resolvedType": "_m32",
        "args": [{
            "type": "MethodCall",
            "resolvedType": "boolean",
            "receiver": { "type": "Identifier", "name": "i", "resolvedType": "i32" },
            "method": "operator<",
            "args": [{ "type": "Identifier", "name": "limit", "resolvedType": "i32" }]
        }]
    },
    "update": {
        "type": "Assign",
        "target": { "type": "Identifier", "name": "i", "resolvedType": "i32" },
        "value": {
            "type": "MethodCall",
            "resolvedType": "i32",
            "receiver": { "type": "Identifier", "name": "i", "resolvedType": "i32" },
            "method": "operator+",
            "args": [{
                "type": "NewExpr",
                "resolvedType": "i32",
                "args": [{ "type": "RawLiteral", "kind": "int", "value": 1 }]
            }]
        }
    },
    "body": [...]
}
```

### IfStmt（`else` / `else if` あり）

`else if` は脱糖によりネストされた `IfStmt` として表現される。

```json
{
    "type": "IfStmt",
    "cond": { "type": "Intrinsic", "name": "__builtin_if", "args": [...] },
    "body": [...],
    "else": {
        "type": "IfStmt",
        "cond": { "type": "Intrinsic", "name": "__builtin_if", "args": [...] },
        "body": [...],
        "else": {
            "type": "ElseStmt",
            "body": [...]
        }
    }
}
```

- `else` フィールドは省略可能（`else` 節がない場合は `null`）
- `else if` は `else` フィールドに `IfStmt` をネストすることで表現する

### MemberAccess

`this.フィールド名` へのアクセスを表すノード。フィールドの参照・代入の両方で使用される。

```json
// this.bits の参照
{
    "type": "MemberAccess",
    "resolvedType": "_m32",
    "receiver": { "type": "Identifier", "name": "this", "resolvedType": "i32" },
    "member": "bits"
}
```

**代入時（`this.bits = raw`）**

```json
{
    "type": "Assign",
    "target": {
        "type": "MemberAccess",
        "resolvedType": "_m32",
        "receiver": { "type": "Identifier", "name": "this", "resolvedType": "i32" },
        "member": "bits"
    },
    "value": { "type": "Identifier", "name": "raw", "resolvedType": "_m32" }
}
```

### BorrowExpr

明示的な借用演算子 `&` および `&mut` を表現する式ノード（所有権・借用システム拡張§5.2 で導入）。

```json
{
    "type": "BorrowExpr",
    "isMut": true,
    "expr": {
        "type": "Identifier",
        "name": "a",
        "resolvedType": "i32"
    },
    "resolvedType": "&mut i32"
}
```

| フィールド | 型 | 説明 |
| --- | --- | --- |
| `type` | string | 固定値 `"BorrowExpr"` |
| `isMut` | boolean | `&mut` の場合は `true`、`&` の場合は `false` |
| `expr` | ASTNode | 借用対象となる式（通常は `Identifier` または `MemberAccess`） |
| `resolvedType` | string | 単一化・解決済みの完全な参照型名（`"&T"` または `"&mut T"`） |

借用演算子の構文詳細および借用ルールは言語仕様書 §5.7/5.8/4.9/4.10 を参照すること。

### ReturnStmt

```json
{
    "type": "ReturnStmt",
    "value": { "type": "Identifier", "name": "result", "resolvedType": "i32" }
}
```

### BreakStmt

```json
{ "type": "BreakStmt" }
```

### BlockStmt

裸ブロック `{ ... }` によって導入されるスコープを表すノード。`body` 内で宣言された変数は当該ブロックに閉じたスコープを持つ。

```json
{
    "type": "BlockStmt",
    "body": [...]
}
```

### 並行プリミティブ（IR ノードなし）

スレッド、ミューテックス、条件変数、アトミック操作は IR ノードとしては表現されず、コアライブラリのクラスメソッド経由で `Intrinsic` ノード（`__builtin_*`）として lower される。具体的には:

- スレッド: `__builtin_thread_spawn(fnName, args) -> _m64`, `__builtin_thread_join(id)`
- スレッドプール: `__builtin_threadpool_create(size) -> _m64`, `__builtin_threadpool_submit(pool, fnName, args)`, `__builtin_threadpool_wait(pool)`, `__builtin_threadpool_destroy(pool)`
- ミューテックス: `__builtin_mutex_create() -> _m64`, `__builtin_mutex_lock(id)`, `__builtin_mutex_unlock(id)`
- 条件変数: `__builtin_condvar_create() -> _m64`, `__builtin_condvar_wait(cv, mutex)`, `__builtin_condvar_signal(cv)`, `__builtin_condvar_broadcast(cv)`
- アトミック (32bit): `__builtin_atomic_load32(ptr, order)`, `__builtin_atomic_store32(ptr, val, order)`, `__builtin_atomic_cas32(ptr, exp, des, successOrder, failureOrder)`, `__builtin_atomic_fetch_add32(ptr, val, order)`, `__builtin_atomic_fetch_sub32(ptr, val, order)`
- アトミック (64bit): `__builtin_atomic_load64(ptr, order)`, `__builtin_atomic_store64(ptr, val, order)`, `__builtin_atomic_cas64(ptr, exp, des, successOrder, failureOrder)`, `__builtin_atomic_fetch_add64(ptr, val, order)`, `__builtin_atomic_fetch_sub64(ptr, val, order)`
- フェンス: `__builtin_atomic_fence(order)`

各バックエンドはこれら `Intrinsic` をネイティブの同期プリミティブ（pthread / Atomics / WASM 線形メモリ + シングルスレッド近似など）に lower する。

### RawLiteral

```json
// 数値リテラル
{ "type": "RawLiteral", "kind": "int", "value": 10 }

// 文字リテラル
{ "type": "RawLiteral", "kind": "char", "value": 104 }
```

---

## 6. 文字列リテラルの展開

文字列リテラルはフロントエンドが `Array<u32>` の生成 + `operator_set[]` メソッド呼び出しの連鎖に展開済みの状態で出力される。**正本はコアライブラリ仕様書§7.2** であり、本仕様はその脱糖結果としての JSON ノード列を示すに留まる。`NewExpr` ノードに専用の `elements` フィールドは存在しない（**MUST NOT**）。

```json
// "hi" の展開例（文 BlockStmt 内に 1 個の VarDecl + 2 個の Assign が並ぶ）
[
    {
        "type": "VarDecl",
        "name": "<tmp>",
        "resolvedType": "Array<u32>",
        "value": {
            "type": "NewExpr",
            "resolvedType": "Array<u32>",
            "args": [
                {
                    "type": "NewExpr",
                    "resolvedType": "u32",
                    "args": [{ "type": "RawLiteral", "kind": "int", "value": 2 }]
                }
            ]
        }
    },
    {
        "type": "Assign",
        "target": {
            "type": "MethodCall",
            "resolvedType": "void",
            "receiver": { "type": "Identifier", "name": "<tmp>", "resolvedType": "Array<u32>" },
            "method": "operator_set[]",
            "args": [
                { "type": "NewExpr", "resolvedType": "u32", "args": [{ "type": "RawLiteral", "kind": "int", "value": 0 }] },
                { "type": "NewExpr", "resolvedType": "u32", "args": [{ "type": "RawLiteral", "kind": "char", "value": 104 }] }
            ]
        },
        "value": null
    },
    {
        "type": "Assign",
        "target": {
            "type": "MethodCall",
            "resolvedType": "void",
            "receiver": { "type": "Identifier", "name": "<tmp>", "resolvedType": "Array<u32>" },
            "method": "operator_set[]",
            "args": [
                { "type": "NewExpr", "resolvedType": "u32", "args": [{ "type": "RawLiteral", "kind": "int", "value": 1 }] },
                { "type": "NewExpr", "resolvedType": "u32", "args": [{ "type": "RawLiteral", "kind": "char", "value": 105 }] }
            ]
        },
        "value": null
    }
]
```

- 旧仕様の `NewExpr.elements` フィールドは廃止（**MUST NOT**）。バックエンドは `elements` を読まないこと。
- 文字列リテラル展開以外の通常の `Array<T>` インスタンス化と完全に同じ AST 形になる。

---

## 7. 完全な出力例

以下のmozaicScriptコードに対するASTの出力例を示す。

**入力（`main.moz`）**

```typescript
import "./core.moc" as *;

public function add(a: i32, b: i32): i32 {
    return a + b;
}
```

**出力（JSON AST）**

```json
{
    "mozaicScript": "0.2.3",
    "nodes": [
        {
            "type": "ImportDecl",
            "path": "./core.moc",
            "namespace": null
        },
        {
            "type": "FunctionDecl",
            "name": "add",
            "access": "public",
            "typeParams": [],
            "params": [
                { "name": "a", "resolvedType": "i32" },
                { "name": "b", "resolvedType": "i32" }
            ],
            "returnType": "i32",
            "body": [
                {
                    "type": "ReturnStmt",
                    "value": {
                        "type": "MethodCall",
                        "resolvedType": "i32",
                        "receiver": {
                            "type": "Identifier",
                            "name": "a",
                            "resolvedType": "i32"
                        },
                        "method": "operator+",
                        "args": [
                            {
                                "type": "Identifier",
                                "name": "b",
                                "resolvedType": "i32"
                            }
                        ]
                    }
                }
            ]
        }
    ]
}
```

---

# Part 2: GPU IR 仕様（GPU Intermediate Representation）

## G1. 凡例および適合性

- 本 Part は GPU カーネルのプラットフォーム中立な中間表現（**GPU IR**）を定義する。
- mozaicScript コンパイラのフロントエンドは、`gpu` 修飾子付き関数（言語仕様書 §14）を CPU 側 IR ではなく**本 IR** に lower する。
- WGSL / SPIR-V / CUDA PTX / Metal MSL などの実 GPU バックエンドは、本 IR を入力として最終形式を生成する。
- 本仕様の準拠は GPU バックエンドに対してのみ要求される。CPU 専用バックエンドは本 IR を生成・消費する必要はない（**OPTIONAL**）。

---

## G2. ファイル形式

GPU IR は JSON 形式で表現される。コンパイラは `.gpu.json` 拡張子で 1 つのソースファイルにつき 1 つの GPU IR ファイルを出力する。例: `vecadd.moz` → `vecadd.gpu.json`。

```json
{
    "mozaicScriptGpu": "1.0",
    "kernels": [ <GpuKernelIR>, ... ]
}
```

| フィールド | 型 | 説明 |
|------------|----|------|
| `mozaicScriptGpu` | string | 本仕様のバージョン番号（現行 `"1.0"`） |
| `kernels` | `GpuKernelIR[]` | 当該ファイルに含まれる全 GPU カーネルの IR |

ソース中に `gpu` 関数が存在しない場合、コンパイラは `.gpu.json` ファイルを生成しない（**MUST NOT**）。

---

## G3. カーネルノード（`GpuKernelIR`）

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
| `workgroupSize` | `[u32, u32, u32]` | `gpu(workgroupSize=...)` で宣言された X/Y/Z 次元値。1次元のみ指定時は Y/Z が `1` |
| `params` | `GpuParam[]` | カーネル引数（ソースの宣言順） |
| `locals` | `GpuLocal[]` | 関数内ローカル変数の集合（事前宣言） |
| `body` | `GpuStmt[]` | 関数本体の文の列 |

### G3.1 `GpuParam`

| フィールド | 型 | 説明 |
|------------|-----|------|
| `name` | string | 引数名 |
| `type` | `GpuType` | 引数の型 |
| `binding` | u32 | 論理バインディングインデックス（WGSL の `@binding(n)`、SPIR-V の descriptor binding に対応）。ポインタ型は `storage_buffer`、スカラー型は `uniform` として lower される |

`binding` 値はカーネル内でユニーク。コンパイラは順序 0, 1, 2, ... を割り当てる（**SHOULD**）。

### G3.2 `GpuLocal`

`GpuVarDecl` で導入されるローカル変数を事前列挙する（SPIR-V が関数先頭で変数領域を確保するために使用）。

| フィールド | 型 | 説明 |
|------------|-----|------|
| `name` | string | 変数名 |
| `type` | `GpuType` | 変数の型 |

---

## G4. 型（`GpuType`）

GPU IR で使用可能な型はすべて文字列で表現する。

| 型タグ | 説明 | 対応する CPU 側型 |
|--------|------|-----------------|
| `"i32"` / `"u32"` / `"i64"` / `"u64"` | 整数 | 同名 |
| `"f32"` / `"f64"` | 浮動小数点 | 同名 |
| `"bool"` | 真偽値 | `boolean` |
| `"ptr<T>"` | グローバルメモリ上の T 要素列への参照（`T` は上記スカラー型または `"struct:Name"`） | `Ptr<T>` |
| `"vec<T,N>"` | N 要素ベクトル（N は 2/3/4、T は `i32`/`u32`/`f32`） | 内部利用のみ |
| `"array<T,N>"` | 固定長 N 要素配列（N はコンパイル時定数） | 同名 |
| `"struct:Name"` | ユーザ定義 plain class | 同名 |

ジェネリック型・参照型・ボックス化されたラッパー型は本 IR に現れない（**MUST NOT**）。コンパイラは `i32` などのラッパークラスを対応するスカラー（`"i32"`）に事前 unbox する（**MUST**）。

---

## G5. 文（`GpuStmt`）

すべての文は `type` フィールドで判別される。

### G5.1 `GpuVarDecl`

```json
{ "type": "GpuVarDecl", "name": "i", "value": <GpuExpr> }
```

型は事前に `kernel.locals` で宣言済みでなければならない。

### G5.2 `GpuAssign`

```json
{ "type": "GpuAssign", "target": <GpuLValue>, "value": <GpuExpr> }
```

`GpuLValue` は次のいずれか。

- `{ "type": "GpuIdent", "name": "i" }`
- `{ "type": "GpuIndex", "base": <GpuExpr>, "index": <GpuExpr> }` — `ptr<T>` / `array<T,N>` への要素書き込み
- `{ "type": "GpuField", "base": <GpuExpr>, "field": "x" }` — struct/vec フィールド書き込み

### G5.3 `GpuIf`

```json
{
    "type": "GpuIf",
    "cond": <GpuExpr>,
    "then": [ <GpuStmt>, ... ],
    "else": [ <GpuStmt>, ... ]
}
```

`else` はオプショナル。

### G5.4 `GpuFor`

```json
{
    "type": "GpuFor",
    "init": <GpuStmt>,
    "cond": <GpuExpr>,
    "update": <GpuStmt>,
    "body": [ <GpuStmt>, ... ]
}
```

### G5.5 `GpuWhile`

```json
{ "type": "GpuWhile", "cond": <GpuExpr>, "body": [ <GpuStmt>, ... ] }
```

### G5.6 `GpuBreak`

```json
{ "type": "GpuBreak" }
```

### G5.7 `GpuReturn`

GPU カーネルの戻り値型は常に `void`（言語仕様書 §14.5）なので、`GpuReturn` は値を持たない。

```json
{ "type": "GpuReturn" }
```

### G5.8 `GpuExprStmt`

副作用のための式（主に void 呼び出し）。

```json
{ "type": "GpuExprStmt", "expr": <GpuExpr> }
```

---

## G6. 式（`GpuExpr`）

### G6.1 `GpuLiteral`

```json
{ "type": "GpuLiteral", "valueType": "u32", "value": 42 }
{ "type": "GpuLiteral", "valueType": "f32", "value": 3.14 }
{ "type": "GpuLiteral", "valueType": "bool", "value": true }
```

### G6.2 `GpuIdent`

```json
{ "type": "GpuIdent", "name": "i", "resolvedType": "u32" }
```

参照する識別子はパラメータかローカル変数のみ。

### G6.3 `GpuBinOp`

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

### G6.4 `GpuUnaryOp`

```json
{ "type": "GpuUnaryOp", "op": "-", "expr": <GpuExpr>, "resolvedType": "f32" }
```

`op` は `-`（符号反転）または `!`（論理否定）。

### G6.5 `GpuIndex`

`ptr<T>` または `array<T,N>` への読み出し。

```json
{ "type": "GpuIndex", "base": <GpuExpr>, "index": <GpuExpr>, "resolvedType": "f32" }
```

### G6.6 `GpuField`

struct/vec フィールド読み出し。

```json
{ "type": "GpuField", "base": <GpuExpr>, "field": "x", "resolvedType": "f32" }
```

### G6.7 `GpuCallBuiltin`

GPU 組み込み命令の呼び出し。本 IR で許される唯一の関数呼び出し（**MUST**）。本バージョンでは GPU 関数間呼び出しは未対応であり、フロントエンドがインライン展開する（**MUST**）。

```json
{
    "type": "GpuCallBuiltin",
    "name": "gpuGlobalId",
    "args": [ <GpuExpr>, ... ],
    "resolvedType": "u32"
}
```

`name` の取りうる値は G7。

---

## G7. GPU 組み込み命令一覧

言語仕様書 §14.4 で公開される組み込み関数は、本 IR では `GpuCallBuiltin.name` として以下の文字列値に lower される。

### G7.1 スレッド ID / ワークグループ情報

| `name` | 戻り型 | WGSL 対応 | SPIR-V 対応 |
|--------|--------|-----------|-------------|
| `"gpuGlobalIdX"` / `"gpuGlobalIdY"` / `"gpuGlobalIdZ"` | u32 | `@builtin(global_invocation_id).{x,y,z}` | `GlobalInvocationId.{x,y,z}` |
| `"gpuGlobalId"` | u32 | `gpuGlobalIdX` の別名 | 同左 |
| `"gpuLocalIdX"` / `"gpuLocalIdY"` / `"gpuLocalIdZ"` | u32 | `@builtin(local_invocation_id).{x,y,z}` | `LocalInvocationId.{x,y,z}` |
| `"gpuLocalId"` | u32 | `gpuLocalIdX` の別名 | 同左 |
| `"gpuWorkgroupIdX"` / `"gpuWorkgroupIdY"` / `"gpuWorkgroupIdZ"` | u32 | `@builtin(workgroup_id).{x,y,z}` | `WorkgroupId.{x,y,z}` |
| `"gpuWorkgroupId"` | u32 | `gpuWorkgroupIdX` の別名 | 同左 |
| `"gpuWorkgroupSize"` | u32 | コンパイル時定数として埋め込み | 同左 |

### G7.2 バリア

| `name` | 戻り型 | WGSL 対応 | SPIR-V 対応 |
|--------|--------|-----------|-------------|
| `"gpuBarrier"` | void | `workgroupBarrier()` | `OpControlBarrier(Workgroup, Workgroup, AcquireRelease\|WorkgroupMemory)` |
| `"gpuStorageBarrier"` | void | `storageBarrier()` | `OpControlBarrier(Workgroup, Workgroup, AcquireRelease\|UniformMemory)` |

### G7.3 アトミック操作

| `name` | 引数 | 戻り型 | WGSL 対応 |
|--------|------|--------|-----------|
| `"gpuAtomicAdd"` | `ptr<u32>, u32` | u32 | `atomicAdd()` |
| `"gpuAtomicSub"` | `ptr<u32>, u32` | u32 | `atomicSub()` |
| `"gpuAtomicMin"` | `ptr<u32>, u32` | u32 | `atomicMin()` |
| `"gpuAtomicMax"` | `ptr<u32>, u32` | u32 | `atomicMax()` |
| `"gpuCompareExchange"` | `ptr<u32>, u32, u32` | `struct:GpuCasResult` | `atomicCompareExchangeWeak()` の結果を `{oldValue, exchanged}` 形に lower |
| `"gpuAtomicLoad"` | `ptr<u32>` | u32 | `atomicLoad()` |
| `"gpuAtomicStore"` | `ptr<u32>, u32` | void | `atomicStore()` |

i32 版は名前末尾に `"I32"` を付与する（例: `"gpuAtomicAddI32"`、`"gpuCompareExchangeI32"` の戻り型は `struct:GpuCasResultI32`）。

> CPU 側の `__builtin_atomic_cas32` / `__builtin_atomic_cas64`（成功=1/失敗=0 を `_m32` で返す）と命名を分離している。同概念だが戻り値規約が異なるため、`Cas` という同一名を共有させない（**MUST NOT**）。

### G7.4 数値ユーティリティ

| `name` | 引数 | 戻り型 | WGSL 対応 |
|--------|------|--------|-----------|
| `"gpuFma"` | `f32, f32, f32` | f32 | `fma()` |
| `"gpuDotF32x4"` | `ptr<f32>, ptr<f32>` | f32 | `dot(vec4<f32>, vec4<f32>)` |

---

## G8. ホスト連携

GPU IR ファイルとは別に、CPU 側 IR（`.ast.json`）には以下のノード／組み込みが現れる。

| CPU 側 IR ノード/組み込み | 説明 |
|------------------------|------|
| `Intrinsic { name: "__builtin_gpu_dispatch", args: [kernelHandle, argsHandle, gridX, gridY, gridZ] }` | コアライブラリ `gpuDispatch()` の lower 形式 |
| `Intrinsic { name: "__builtin_gpu_sync" }` | コアライブラリ `gpuSync()` の lower 形式 |
| `Intrinsic { name: "__builtin_gpu_flush" }` | コアライブラリ `gpuFlush()` の lower 形式 |
| `Intrinsic { name: "__builtin_gpu_kernel_handle", args: ["vecAdd"] }` | カーネル名から `GpuKernel` の内部ハンドルを取得する（フロントエンドが `GpuKernel` 定数参照箇所に挿入） |

各 GPU バックエンドは `.gpu.json` を実 GPU 形式（`.wgsl` / `.spv` / `.metal` …）に変換し、ランタイム側で `__builtin_gpu_dispatch` 受領時にロード・ディスパッチする。

---

## G9. バージョニング

メジャー番号変更時は IR 構造変更を伴う（後方非互換の可能性あり）。マイナー番号変更時は後方互換を維持する（**MUST**）。コンパイラは `mozaicScriptGpu` フィールドのバージョン文字列を必ず出力すること（**MUST**）。
