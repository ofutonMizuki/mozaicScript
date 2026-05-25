# mozaicScript

静的型付けの自作プログラミング言語です。TypeScript で実装されたコンパイラとインタプリタで構成されています。

## 概要

mozaicScript は型推論なし・完全型明示を基本方針とする言語です。ソースコードは一度 IR（中間表現）JSON にコンパイルされ、ツリーウォーキング型のインタプリタで実行されます。

## 必要環境

- Node.js
- npm

## セットアップ

```bash
npm install
```

## 使い方

### コンパイル

`.moz` ファイルを IR JSON (`.ast.json`) にコンパイルします。

```bash
npx ts-node compiler/index.ts <entry.moz>
```

### 実行

コンパイル済みの `.ast.json` を実行します。

```bash
npx ts-node interpreter/index.ts <main.moz.ast.json>
```

### サンプルを動かす

FizzBuzz サンプル (`sample/main.moz`) をコンパイル＆実行します。

```bash
npx ts-node compiler/index.ts sample/main.moz
npx ts-node interpreter/index.ts sample/main.moz.ast.json
```

### TypeScript のビルド

```bash
npm run build
```

## ベンチマークとテスト

`bench/` に回帰テストと速度ベンチが入っています。mozaicScript は同一の IR を **4 つの実行系**（ツリーウォーキング インタプリタ／C コード生成／JavaScript コード生成／WebAssembly コード生成）で実行できるため、それらの**出力一致**と**速度**を検証します。生成物（`.ast.json` / `.c` / `.js` / `.wasm` / バイナリ）は一時フォルダに出力され、`bench/` にはソースのみを置きます。

### 回帰テスト

```bash
bash bench/run_tests.sh                 # 検査
bash bench/run_tests.sh --update-golden # ゴールデン基準を更新
```

各 `correct_*.moz` について次を検査します。

- **オプティマイザ不変性** — interpreter を `-O0/-O1/-O2` で実行して出力一致
- **バックエンド間一致** — interpreter / C / JS / WASM の出力一致
- **スナップショット回帰** — `bench/golden/`（初回自動生成・git 管理外）との比較

### 速度ベンチ

```bash
bash bench/run_bench.sh
```

各ベンチ（`loopsum` / `fib` / `primes` / `collatz` / `matrix` / `mandelbrot`）を以下の実行系で計測し、チェックサム一致も確認します。`bench/native/` の手書きネイティブ実装と比較することで、生成コードのオーバーヘッドを把握できます。

| 列 | 実行系 |
|----|--------|
| `interp` | ツリーウォーキング インタプリタ |
| `moz-JS` | JS バックエンド生成コード（node） |
| `nat-JS` | 手書きネイティブ JS（`bench/native/`） |
| `mozC-O0` / `mozC-O2` | C バックエンド生成 + gcc -O0 / -O2 |
| `natC-O0` / `natC-O2` | 手書きネイティブ C + gcc -O0 / -O2 |

> `bench/util.moz` はコアに整数→文字列変換が無いため自作した `printInt` 等を提供し、各テスト/ベンチの結果出力に使われます。

## コードサンプル

```mozaic
import "./core.moc" as *;

public function main(): void {
    let out: Stdout = new Stdout();

    for (let i: i32 = new i32(1); i <= new i32(100); i = i + new i32(1)) {
        if (i % new i32(15) == new i32(0)) {
            out.writeLine("FizzBuzz");
        } else {
            if (i % new i32(3) == new i32(0)) {
                out.writeLine("Fizz");
            } else {
                if (i % new i32(5) == new i32(0)) {
                    out.writeLine("Buzz");
                } else {
                    out.writeInt(i);
                }
            }
        }
    }
}
```

## 言語の特徴

### ファイル種別

| 拡張子 | 用途 |
|--------|------|
| `.moz` | ユーザーコード |
| `.moc` | コアライブラリ（特権モード） |

`.moc` ファイルのみ、機械レベルのプリミティブ型 (`_m32`, `_m64`, `_m128`, `_m256`) と `__builtin_*` 組み込み関数を使用できます。

### 型システム

- **型推論なし** — すべての変数・引数・戻り値に型アノテーションが必須
- **`any` 型なし** — 仕様上存在しない
- **暗黙的型変換なし** — 型変換はコンストラクタまたはメソッドで明示的に行う

### アクセス修飾子

| 修飾子 | アクセス範囲 |
|--------|-------------|
| `public` | どこからでもアクセス可能 |
| `private` | クラス内のみ |
| `mocp public` | `.moc` ファイルからのみアクセス可能 |

### 演算子

演算子はメソッドとして実装されています (`operator+`, `operator==`, `operatorNot` など)。

### インポート

```mozaic
import "./path.moc" as *;   // グローバル名前空間に展開
import "./path.moc" as NS;  // 名前付き名前空間
```

## アーキテクチャ

```
ソース (.moz/.moc)
    ↓ lexer.ts     トークン列に分割
    ↓ parser.ts    内部パースツリー (PExpr, PStmt, ...) を生成
    ↓ checker.ts   型検査 + IR への変換 → .ast.json 出力
    ↓
IR JSON (.ast.json)
    ↓ evaluator.ts ツリーウォーキング実行
    ↓
実行結果
```

### コンパイラ (`compiler/`)

| ファイル | 役割 |
|----------|------|
| `lexer.ts` | ソースをトークン列に変換 |
| `parser.ts` | 再帰下降パーサ。内部パースツリーを生成 |
| `checker.ts` | 型検査 + IR JSON への変換・出力 |

### インタプリタ (`interpreter/`)

| ファイル | 役割 |
|----------|------|
| `evaluator.ts` | `.ast.json` を読み込み `main()` を実行するツリーウォーカー |
| `environment.ts` | レキシカルスコープチェーン |
| `values.ts` | ランタイム値型 (`PrimitiveValue`, `ObjectValue`, `VoidValue`) |
| `builtins.ts` | `__builtin_*` 組み込み関数・`HeapManager`・`PanicError` |

## ドキュメント

詳細な仕様は `doc/` ディレクトリにあります。

| ファイル | 内容 |
|----------|------|
| `mozaicScript-spec-v0_2_3.md` | 言語仕様（型、文、式、アクセス制御） |
| `mozaicScript-corelib-spec-v0_1_2.md` | コアライブラリ仕様 (`i32`, `u32`, `f32`, `boolean`, `Array`, `Stdout`, …) |
| `mozaicScript-ir-spec-v0_1_2.md` | IR JSON フォーマット仕様 |
| `mozaicScript-engine-spec-v0_1_2.md` | インタプリタ・エンジン仕様 |
