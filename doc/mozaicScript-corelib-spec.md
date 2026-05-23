# 📄 mozaicScript コアライブラリ仕様書

本仕様書は mozaicScript 言語仕様書に基づき、`core.moc` として実装されるコアライブラリの仕様を定義する。

---

## 0. 実装の自由度

コアライブラリの実装者は、本仕様書が定める以下の要件を満たす限り、内部実装を自由に決定してよい。

- 必須クラスをすべて提供すること（**MUST**）
- 各クラスの必須メソッドをすべて実装すること（**MUST**）
- 必須メソッドの外部から見た挙動が仕様と一致すること（**MUST**）
- 内部実装（フィールド名・補助メソッド・最適化など）は自由とする
- 本仕様書の実装例はあくまで参考であり、これに従う義務はない

---

## 1. 概要

コアライブラリは `.moc` 拡張子を持つ特権ファイルとして実装される。ユーザーコードはすべて以下のようにインポートして使用する。

```typescript
import "./core.moc" as *;
```

---

## 2. 型エイリアス定義

```typescript
type char = u32;
type string = Array<char>;
```

---

## 3. 必須クラス一覧

すべての実装が提供しなければならないクラス。

| クラス | 説明 |
|--------|------|
| `boolean` | 真偽値 |
| `i32` | 符号あり32bit整数 |
| `u32` | 符号なし32bit整数 |
| `f32` | 32bit浮動小数点数（IEEE 754） |
| `i64` | 符号あり64bit整数（ビットボード演算等に必須） |
| `u64` | 符号なし64bit整数（ビットボード演算等に必須） |
| `f64` | 64bit浮動小数点数（IEEE 754、MLP学習に必須） |
| `Result<T>` | エラーハンドリングコンテナ |
| `Option<T>` | オプショナル値コンテナ |
| `Array<T>` | ジェネリクス配列 |
| `Ptr<T>` | 型付きポインタ（低レベルメモリ操作、主に `.moc` 内部用） |
| `Stdout` | 標準出力ハンドル |
| `Stderr` | 標準エラーハンドル |
| `Stdin` | 標準入力ハンドル |

必須グローバル関数（`print`, `eprint`, `readLine`, `panic`, スレッド関連）は §6 に記述する。
必須グローバル定数（`STDOUT`, `STDERR`, `STDIN`）は §6.7 に記述する。

---

## 5. 必須メソッド仕様

各プリミティブ型は内部表現として `mocp public let bits: _mNN` フィールドを持つ（`_m32` 型は 32bit、`_m64` 型は 64bit）。このフィールドは `.moc` ファイル内からのみアクセス可能であり、`.moz` ユーザーコードからは利用不可。

### 5.1 `boolean`

| メソッド | 説明 |
|----------|------|
| `operator==(other: boolean): boolean` | 等価比較 |
| `operator\|\|(other: boolean): boolean` | 論理OR |
| `operator&&(other: boolean): boolean` | 論理AND |
| `operatorNot(): boolean` | 論理NOT |

`mocp public let bits: _m32` — 内部表現フィールド（`.moc` 内専用）

### 5.2 `i32`

| メソッド | 説明 |
|----------|------|
| `operator+(other: i32): i32` | 加算 |
| `operator-(other: i32): i32` | 減算 |
| `operator*(other: i32): i32` | 乗算 |
| `operator/(other: i32): i32` | 除算 |
| `operator%(other: i32): i32` | 剰余 |
| `operator==(other: i32): boolean` | 等価比較 |
| `operator<(other: i32): boolean` | 小なり |
| `operator>(other: i32): boolean` | 大なり |
| `negate(): i32` | 符号反転（単項マイナス） |
| `clz(): i32` | 先頭ゼロビット数 |
| `ctz(): i32` | 末尾ゼロビット数 |
| `popcnt(): i32` | 1ビット数 |
| `rotl(shift: i32): i32` | 左回転 |
| `rotr(shift: i32): i32` | 右回転 |
| `shl(shift: i32): i32` | 論理左シフト |
| `shr(shift: i32): i32` | 算術右シフト |
| `toU32(): u32` | u32へ変換 |
| `toI64(): i64` | i64へ変換（符号拡張） |
| `toF32(): f32` | f32へ変換 |
| `toF64(): f64` | f64へ変換 |

`mocp public let bits: _m32` — 内部表現フィールド

### 5.3 `u32`

符号なし整数のため `negate()` は定義されない。シフト命令は論理シフト（符号なし）を使用する。

| メソッド | 説明 |
|----------|------|
| `operator+(other: u32): u32` | 加算 |
| `operator-(other: u32): u32` | 減算 |
| `operator*(other: u32): u32` | 乗算 |
| `operator/(other: u32): u32` | 除算 |
| `operator%(other: u32): u32` | 剰余 |
| `operator==(other: u32): boolean` | 等価比較 |
| `operator<(other: u32): boolean` | 小なり |
| `operator>(other: u32): boolean` | 大なり |
| `shl(shift: u32): u32` | 論理左シフト |
| `shr(shift: u32): u32` | 論理右シフト |
| `toI32(): i32` | i32へ変換 |
| `toU64(): u64` | u64へ変換（ゼロ拡張） |
| `toF32(): f32` | f32へ変換 |
| `toF64(): f64` | f64へ変換 |

`mocp public let bits: _m32` — 内部表現フィールド

### 5.4 `f32`

| メソッド | 説明 |
|----------|------|
| `operator+(other: f32): f32` | 加算 |
| `operator-(other: f32): f32` | 減算 |
| `operator*(other: f32): f32` | 乗算 |
| `operator/(other: f32): f32` | 除算 |
| `operator==(other: f32): boolean` | 等価比較（IEEE 754準拠） |
| `operator<(other: f32): boolean` | 小なり |
| `operator>(other: f32): boolean` | 大なり |
| `negate(): f32` | 符号反転 |
| `abs(): f32` | 絶対値 |
| `sqrt(): f32` | 平方根 |
| `floor(): f32` | 切り捨て（負の無限大方向） |
| `ceil(): f32` | 切り上げ（正の無限大方向） |
| `trunc(): f32` | ゼロ方向への切り捨て |
| `nearest(): f32` | 最近接偶数丸め |
| `min(other: f32): f32` | 小さい方 |
| `max(other: f32): f32` | 大きい方 |
| `sin(): f32` | 正弦（ラジアン） |
| `cos(): f32` | 余弦（ラジアン） |
| `tan(): f32` | 正接（ラジアン） |
| `exp(): f32` | 指数関数（e^x） |
| `log(): f32` | 自然対数 |
| `pow(exponent: f32): f32` | 累乗 |
| `atan(): f32` | 逆正接 |
| `atan2(x: f32): f32` | 2引数逆正接 |
| `toI32(): i32` | i32へ変換（小数点以下切り捨て） |
| `toU32(): u32` | u32へ変換（小数点以下切り捨て） |
| `toF64(): f64` | f64へ変換（精度拡張） |

`mocp public let bits: _m32` — 内部表現フィールド

### 5.5 `i64`

| メソッド | 説明 |
|----------|------|
| `operator+(other: i64): i64` | 加算 |
| `operator-(other: i64): i64` | 減算 |
| `operator*(other: i64): i64` | 乗算 |
| `operator/(other: i64): i64` | 除算 |
| `operator%(other: i64): i64` | 剰余 |
| `operator==(other: i64): boolean` | 等価比較 |
| `operator<(other: i64): boolean` | 小なり |
| `operator>(other: i64): boolean` | 大なり |
| `negate(): i64` | 符号反転 |
| `clz(): i64` | 先頭ゼロビット数 |
| `popcnt(): i64` | 1ビット数 |
| `rotl(shift: i64): i64` | 左回転 |
| `shl(shift: i64): i64` | 論理左シフト |
| `shr(shift: i64): i64` | 算術右シフト |
| `toI32(): i32` | i32へ変換（下位32bit） |
| `toF64(): f64` | f64へ変換 |

`mocp public let bits: _m64` — 内部表現フィールド

### 5.6 `u64`

符号なし整数のため `negate()` は定義されない。シフト命令は論理シフトを使用する。

| メソッド | 説明 |
|----------|------|
| `operator+(other: u64): u64` | 加算 |
| `operator-(other: u64): u64` | 減算 |
| `operator*(other: u64): u64` | 乗算 |
| `operator/(other: u64): u64` | 除算 |
| `operator%(other: u64): u64` | 剰余 |
| `operator==(other: u64): boolean` | 等価比較 |
| `operator<(other: u64): boolean` | 小なり |
| `operator>(other: u64): boolean` | 大なり |
| `shl(shift: u64): u64` | 論理左シフト |
| `shr(shift: u64): u64` | 論理右シフト |
| `toU32(): u32` | u32へ変換（下位32bit） |
| `toF64(): f64` | f64へ変換 |

`mocp public let bits: _m64` — 内部表現フィールド

### 5.7 `f64`

| メソッド | 説明 |
|----------|------|
| `operator+(other: f64): f64` | 加算 |
| `operator-(other: f64): f64` | 減算 |
| `operator*(other: f64): f64` | 乗算 |
| `operator/(other: f64): f64` | 除算 |
| `operator%(other: f64): f64` | 剰余 |
| `operator==(other: f64): boolean` | 等価比較（IEEE 754準拠） |
| `operator<(other: f64): boolean` | 小なり |
| `operator>(other: f64): boolean` | 大なり |
| `negate(): f64` | 符号反転 |
| `abs(): f64` | 絶対値 |
| `sqrt(): f64` | 平方根 |
| `floor(): f64` | 切り捨て |
| `ceil(): f64` | 切り上げ |
| `trunc(): f64` | ゼロ方向切り捨て |
| `nearest(): f64` | 最近接偶数丸め |
| `min(other: f64): f64` | 小さい方 |
| `max(other: f64): f64` | 大きい方 |
| `sin(): f64` | 正弦 |
| `cos(): f64` | 余弦 |
| `exp(): f64` | 指数関数 |
| `log(): f64` | 自然対数 |
| `pow(exponent: f64): f64` | 累乗 |
| `atan2(x: f64): f64` | 2引数逆正接 |
| `toI64(): i64` | i64へ変換（切り捨て） |
| `toF32(): f32` | f32へ変換（精度縮小） |

`mocp public let bits: _m64` — 内部表現フィールド

### 5.8 `Result<T>`

| メソッド | 説明 |
|----------|------|
| `isOk(): boolean` | 成功かどうかを確認する |
| `isErr(): boolean` | 失敗かどうかを確認する |
| `unwrap(): T` | 成功時の値を取り出す（失敗時はパニック） |
| `unwrapErr(): string` | 失敗時のエラーメッセージを取り出す（成功時はパニック） |

**コンストラクタ：**
```typescript
new Result<T>(success: boolean, val: T, err: string)
```

`success = TRUE` → Ok(val)（`err` は空文字列 `""`）  
`success = FALSE` → Err(err)（`val` はダミー値）

### 5.9 `Option<T>`

`some` / `none` 状態はコンストラクタで生成する。

```typescript
// some 相当（値あり）
new Option<T>(TRUE, someValue);

// none 相当（値なし）
new Option<T>(FALSE, dummyValue);
```

| メソッド | 説明 |
|----------|------|
| `isSome(): boolean` | 値があるかどうかを確認する |
| `isNone(): boolean` | 値がないかどうかを確認する |
| `unwrap(): T` | 値を取り出す（値なし時はパニック） |

### 5.10 `Array<T>`

| メンバ / メソッド | 説明 |
|------------------|------|
| `public let length: u32` | 要素数フィールド |
| `operator[](index: u32): T` | インデックス参照 |
| `operator_set[](index: u32, value: T): void` | インデックス代入 |
| `free(): void` | メモリ解放 |

**コンストラクタ：**
```typescript
new Array<T>(size: u32)
```

### 5.11 `Ptr<T>`

型付きポインタ。ヌルポインタはアドレス `0` として表現される。

コンストラクタ引数に `_m32` を使用するため、直接インスタンス化は `.moc` ファイルからのみ可能。`.moz` コードはライブラリ関数が返す `Ptr<T>` を受け取って使用する。

`T` は単一の `_m32`（または `_m64`）フィールドを持つクラスに限定される（`Array<T>` と同じ制約）。

| メソッド | 説明 |
|----------|------|
| `deref(): T` | ポインタが指す値を読み取る |
| `write(val: T): void` | ポインタが指す先に値を書き込む |
| `isNull(): boolean` | ヌルポインタ（アドレス 0）かどうか確認 |
| `free(): void` | ポインタが確保するメモリを解放 |

`mocp public let addr: _m32` — 内部アドレスフィールド（`.moc` 内専用）

### 5.12 `Stdout` / `Stderr`

標準出力・標準エラーへの書き出しを行うクラス。グローバル定数 `STDOUT` / `STDERR`（§6.7）でアクセスする。

| メソッド | 説明 |
|----------|------|
| `write(s: string): void` | 文字列を出力（改行なし） |
| `writeLine(s: string): void` | 文字列を出力して末尾に改行を付加 |

`mocp public let handle: _m32` — 内部ハンドル（`.moc` 内専用）

### 5.13 `Stdin`

標準入力から読み込むクラス。グローバル定数 `STDIN`（§6.7）でアクセスする。

| メソッド | 説明 |
|----------|------|
| `readLine(): string` | 標準入力から 1 行読み込む（末尾の改行は含まない） |

`mocp public let handle: _m32` — 内部ハンドル（`.moc` 内専用）

---

## 6. 必須グローバル関数

### 6.1 標準 I/O

| 関数 | 説明 |
|------|------|
| `print(s: string): void` | 標準出力へ文字列を出力 |
| `eprint(s: string): void` | 標準エラーへ文字列を出力 |
| `readLine(): string` | 標準入力から1行読み込む |
| `panic(msg: string): void` | エラーメッセージを出力してプロセスを終了する |

### 6.2 スレッド管理

| 関数 | 説明 |
|------|------|
| `threadSpawn(fnName: string): u64` | 名前付き関数を新しいスレッドで起動する |
| `threadJoin(id: u64): void` | スレッドの終了を待機する |

### 6.3 スレッドプール

| 関数 | 説明 |
|------|------|
| `threadpoolCreate(size: u32): u64` | 指定サイズのスレッドプールを作成する |
| `threadpoolSubmit(pool: u64, fnName: string): void` | タスクを投入する |
| `threadpoolWait(pool: u64): void` | すべてのタスクの完了を待機する |
| `threadpoolDestroy(pool: u64): void` | スレッドプールを破棄する |

### 6.4 ミューテックス

| 関数 | 説明 |
|------|------|
| `mutexCreate(): u64` | ミューテックスを作成する |
| `mutexLock(m: u64): void` | ロックを取得する |
| `mutexUnlock(m: u64): void` | ロックを解放する |

### 6.5 条件変数

| 関数 | 説明 |
|------|------|
| `condvarCreate(): u64` | 条件変数を作成する |
| `condvarWait(cv: u64, mutex: u64): void` | 条件変数を待機する |
| `condvarSignal(cv: u64): void` | 待機中のスレッドを1つ起こす |
| `condvarBroadcast(cv: u64): void` | 待機中のスレッドをすべて起こす |

### 6.6 アトミック操作

| 関数 | 説明 |
|------|------|
| `atomicLoad(ptr: u32): u32` | アトミックにロードする |
| `atomicStore(ptr: u32, val: u32): void` | アトミックにストアする |
| `atomicCas(ptr: u32, expected: u32, desired: u32): u32` | Compare-And-Swap |
| `atomicFetchAdd(ptr: u32, val: u32): u32` | アトミック加算（加算前の値を返す） |
| `atomicFetchSub(ptr: u32, val: u32): u32` | アトミック減算（減算前の値を返す） |

### 6.7 グローバル定数

| 定数 | 型 | 説明 |
|------|----|------|
| `STDOUT` | `Stdout` | 標準出力シングルトン |
| `STDERR` | `Stderr` | 標準エラーシングルトン |
| `STDIN` | `Stdin` | 標準入力シングルトン |

---

## 7. `Array<T>` 関連の構文規則

### 7.1 インデックス演算子の脱糖

コンパイラは `[]` 構文を以下の通り脱糖する。

| ユーザーコード | 脱糖後 |
|----------------|--------|
| `a[i]` | `a.operator[](i)` |
| `a[i] = v` | `a.operator_set[](i, v)` |

### 7.2 文字列リテラルの展開

コンパイラは文字列リテラル（`"hello"` など）を `Array<u32>` のインスタンス化へ自動展開する。

```typescript
// ユーザーコード
const s: string = "hello";

// コンパイラ内部での展開後
const s: Array<u32> = new Array<u32>(new u32(5));
s[new u32(0)] = new u32(104); // 'h'
s[new u32(1)] = new u32(101); // 'e'
s[new u32(2)] = new u32(108); // 'l'
s[new u32(3)] = new u32(108); // 'l'
s[new u32(4)] = new u32(111); // 'o'
```

各文字の数値表現は実装依存とする（UTF-32推奨）。
