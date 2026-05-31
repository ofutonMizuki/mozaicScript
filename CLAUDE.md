# CLAUDE.md

このファイルは、このリポジトリで作業する Claude Code (claude.ai/code) 向けのガイダンスを提供します。

## コマンド

```bash
# .moz/.moc ソースをコンパイル → *.ast.json（gpu 関数があれば *.gpu.json も生成）
# -O0: 最適化なし  -O1: インライン展開のみ  -O2: 全最適化（デフォルト）
npx ts-node compiler/index.ts [-O0|-O1|-O2] <entry.moz>

# コンパイル済み IR を実行
npx ts-node interpreter/index.ts <entry.moz.ast.json>

# コード生成（各バックエンドは <entry>.ast.json を読む。引数には .moz パスを渡す）
npx ts-node codegen/index.ts <entry.moz> [output.c]        # → C（-lpthread が必須）
npx ts-node jscodegen/index.ts <entry.moz> [output.js]     # → JavaScript
npx ts-node wasmcodegen/index.ts <entry.moz> [output.wasm] # → WebAssembly バイナリ

# 生成ファイルの実行
gcc -o <bin> <output.c> -lm -lpthread && ./<bin>
node <output.js>
node wasmcodegen/run.js <output.wasm>

# GPU シェーダ生成（コンパイラが出力した *.gpu.json を消費）
npx ts-node wgslcodegen/index.ts <entry.moz> [output.wgsl]
node wgslcodegen/run.js <entry.moz>        # WebGPU ランタイムで実行

npx ts-node mslcodegen/index.ts <entry.moz> [output.metal]
swift mslcodegen/run.swift <entry.moz>     # Mac で実行

# TypeScript 型チェック / ビルド（compiler/ interpreter/ codegen/ のみ対象）
npm run build

# 回帰テスト：オプティマイザ不変性 + 4バックエンド一致 + ゴールデンスナップショット
bash bench/run_tests.sh
bash bench/run_tests.sh --update-golden

# 速度ベンチ（事前に npm run build が必要）
bash bench/run_bench.sh

# 仕様カタログ突き合わせリント
npm run spec-lint
npm run spec-lint -- --rules R1,R3
```

各フォルダの詳細は各 `README.md` を参照。

## アーキテクチャ

### IR が全バックエンドの共有コントラクト

`compiler/` がソースを IR JSON（`*.ast.json`）に変換し、4 つのホストバックエンドが同じ IR を消費する。

```
compiler/  →  *.ast.json  →  interpreter/
                          →  codegen/      (→ .c → gcc)
                          →  jscodegen/    (→ .js → node)
                          →  wasmcodegen/  (→ .wasm → node run.js)
           →  *.gpu.json  →  wgslcodegen/  (→ .wgsl)
                          →  mslcodegen/   (→ .metal)
```

**`interpreter/types.ts` を変更すると上記すべてのディレクトリに影響する。**

### 2 種類の IR 形式——混同禁止

| 型定義ファイル | 用途 | 型名プレフィックス |
|---|---|---|
| `compiler/ast.ts` | コンパイラ内部のパースツリー。外には出ない | `P`（`PExpr`, `PStmt`, …） |
| `interpreter/types.ts` | ディスクに書き出される IR。全バックエンドが読む | なし（`ASTNode`, `ClassDecl`, …） |

`checker.ts` だけが両者を知っており、`compiler/ast.ts` 型を受け取って `interpreter/types.ts` ノードを出力する。

### 言語の重要事項

**ファイル種別**
- `.moz` — ユーザーコード。`_m8`/`_m16`/`_m32`/`_m64` などのマシン型と `__builtin_*` 命令は使用不可。
- `.moc` — コアライブラリ（特権モード）。マシン型と `__builtin_*` が使えるのはここだけ。

**型システム** — 型推論なし。全変数・引数・戻り値に型アノテーション必須。`any` なし、暗黙キャストなし。変換はコンストラクタかメソッド経由のみ。

**アクセス修飾子** — `public` / `private` / `mocp public`（`.moc` ファイルからのみアクセス可。`.moz` からは不可）。

**演算子** — メソッドとして実装: `operator+`, `operator==`, `operatorNot` など。

**インポート** — `import "./path.moc" as *;`（グロブ）または `import "./path.moc" as NS;`（名前付き）。

### GPU 固有の制約

- `gpu function` は 4 ホストバックエンドすべてで CPU エミュレーションとして実行される。実 GPU へのパスは `*.gpu.json` → wgslcodegen / mslcodegen。
- `gpu → gpu` 関数呼び出しはチェッカーで拒否される（インライン展開が未実装。直接再帰も同様）。
- メソッドレベルジェネリクス（例: `buf.mapWrite<f32>()`）は codegen が非対応。`sample/gpu.moc` が型特殊化版（`mapWriteF32` / `mapReadI32` 等）を提供。

### 既知の仕様–実装乖離

仕様として確定済みだが**実装がまだ追従していない**項目（詳細は `OPEN-QUESTIONS.md`）:

| 項目 | 仕様の規定 | 実装の現状 |
|---|---|---|
| M1 | アトミック命令名は `__builtin_atomic_load32`/`64` など | `interpreter/builtins.ts` は sans-suffix 名で登録 |
| M2 | `__builtin_malloc`/`__builtin_mem_*` はバイトアドレス | `HeapManager` はワードインデックス（byte/4） |
| M3 | `BorrowExpr` を evaluator で評価、`FunctionDecl` に `isMut` | `evaluator.ts` が `BorrowExpr` を未処理 |
| M4 | 文字列リテラルは `operator_set[]` 連鎖に展開 | `evalNewExpr` に `node.elements` 分岐が残存 |
| M5 | GPU CAS は `gpuCompareExchange` に改名 | `sample/gpu.moc` は `gpuAtomicCas` のまま |

これらを黙って修正しないこと。複数バックエンドにわたる協調変更が必要で、変更後は `bench/run_tests.sh` で確認する。
