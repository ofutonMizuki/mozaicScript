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
| `Exception` | エラー情報 |
| `Result<T>` | エラーハンドリングコンテナ |
| `Option<T>` | オプショナル値コンテナ |
| `Array<T>` | ジェネリクス配列 |
| `Ptr<T>` | ポインタ |
| `Stdout` | 標準出力 |
| `Stderr` | 標準エラー出力 |
| `Stdin` | 標準入力 |

---

## 5. 必須メソッド仕様

### 5.1 `boolean`

| メソッド | 説明 |
|----------|------|
| `operator==(other: boolean): boolean` | 等価比較 |
| `operator\|\|(other: boolean): boolean` | 論理OR |
| `operator&&(other: boolean): boolean` | 論理AND |
| `operatorNot(): boolean` | 論理NOT |
| `getBits(): _m32` | 内部表現取得（`mocp public`） |

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
| `toF32(): f32` | f32へ変換 |
| `toU32(): u32` | u32へ変換 |
| `operatorNeg(): i32` | 単項マイナス |
| `getBits(): _m32` | 内部表現取得（`mocp public`） |

### 5.3 `u32`

`i32` と同一のメソッド一覧（**ただし `operatorNeg()` を除く**）。内部の組み込み命令のみ符号なし版を使用する。`operatorNeg()` は符号なし整数に対して定義されない（`__builtin_u32_neg` は存在しない）。

| 追加メソッド | 説明 |
|-------------|------|
| `toF32(): f32` | f32へ変換 |
| `toI32(): i32` | i32へ変換 |
| `getBits(): _m32` | 内部表現取得（`mocp public`） |

### 5.4 `f32`

`i32` と同一のメソッド一覧。内部の組み込み命令のみ浮動小数点版を使用する。浮動小数点数の等価比較（`==`）はIEEE 754の仕様に従う。

| 追加メソッド | 説明 |
|-------------|------|
| `toI32(): i32` | i32へ変換（小数点以下切り捨て） |
| `toU32(): u32` | u32へ変換（小数点以下切り捨て） |
| `operatorNeg(): f32` | 単項マイナス |
| `getBits(): _m32` | 内部表現取得（`mocp public`） |

### 5.5 `i64`

`i32` と同一のメソッド構成。内部の組み込み命令は `__builtin_i64_*` 系を使用する。

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
| `operatorNeg(): i64` | 単項マイナス |
| `toI32(): i32` | i32へ変換（下位32bit） |
| `toF64(): f64` | f64へ変換 |
| `getBits(): _m64` | 内部表現取得（`mocp public`） |

### 5.6 `u64`

`i64` と同一のメソッド構成（**ただし `operatorNeg()` を除く**）。内部の組み込み命令は `__builtin_u64_*` 系を使用する。

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
| `toU32(): u32` | u32へ変換（下位32bit） |
| `toF64(): f64` | f64へ変換 |
| `getBits(): _m64` | 内部表現取得（`mocp public`） |

### 5.7 `f64`

`f32` と同一のメソッド構成。内部の組み込み命令は `__builtin_f64_*` 系を使用する。

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
| `operatorNeg(): f64` | 単項マイナス |
| `toI64(): i64` | i64へ変換（切り捨て） |
| `toF32(): f32` | f32へ変換（精度縮小） |
| `getBits(): _m64` | 内部表現取得（`mocp public`） |

### 5.8 `Exception`

| メンバ | 説明 |
|--------|------|
| `message: string` | エラーメッセージ（`public` フィールド） |

### 5.9 `Result<T>`

| メソッド | 説明 |
|----------|------|
| `unwrap(): T` | 成功時の値を取り出す（失敗時はパニック） |
| `isOk(): boolean` | 成功かどうかを確認する |
| `getError(): Exception` | 失敗時のエラーを取り出す（成功時の挙動は実装依存） |

**コンストラクタ：**
```typescript
new Result<T>(success: boolean, val: T, err: Exception)
```

### 5.10 `Option<T>`

`some` / `none` 状態はコンストラクタで生成する。

```typescript
// some 相当（値あり）
new Option<i32>(new boolean(true), new i32(42));

// none 相当（値なし）
new Option<i32>(new boolean(false), __builtin_zeroinit());
```

| メソッド | 説明 |
|----------|------|
| `isSome(): boolean` | 値があるかどうかを確認する |
| `unwrap(): T` | 値を取り出す（値なし時はパニック） |

### 5.11 `Array<T>`

| メソッド | 説明 |
|----------|------|
| `operator[](index: i32): T` | インデックス参照 |
| `operator_set[](index: i32, value: T): void` | インデックス代入 |
| `length` | 要素数（`public` フィールド） |
| `copy(): Array<T>` | シャローコピー（内部ポインタを共有） |
| `clone(): Array<T>` | ディープコピー（新しいメモリに値をコピー） |
| `free(): void` | メモリ解放 |
| `getPtr(): _m32` | 内部ポインタ取得（`mocp public`） |

### 5.12 `Ptr<T>`

ヌルポインタはアドレス `0` として表現される。

| メソッド | 説明 |
|----------|------|
| `deref(): T` | ポインタが指す値を取得 |
| `write(val: T): void` | ポインタが指す先に値を書き込む |
| `isNull(): boolean` | ヌルポインタかどうか確認 |
| `free(): void` | メモリ解放 |
| `getAddr(): _m32` | アドレス取得（`mocp public`） |

### 5.13 `Stdout` / `Stderr`

| メソッド | 説明 |
|----------|------|
| `write(s: string): void` | 文字列を出力 |
| `writeLine(s: string): void` | 文字列を出力して改行 |

### 5.14 `Stdin`

| メソッド | 説明 |
|----------|------|
| `readLine(): string` | 1行読み込む |

---

## 6. 実装例

```typescript
// boolean クラス
public class boolean {
    private let bits: _m32;
    public constructor(raw: _m32) { this.bits = raw; }

    mocp public function getBits(): _m32 { return this.bits; }

    public operator==(other: boolean): boolean {
        return new boolean(__builtin_i32_eq(this.getBits(), other.getBits()));
    }
    public operator||(other: boolean): boolean {
        return new boolean(__builtin_i32_or(this.getBits(), other.getBits()));
    }
    public operator&&(other: boolean): boolean {
        return new boolean(__builtin_i32_and(this.getBits(), other.getBits()));
    }
    public operatorNot(): boolean {
        return new boolean(__builtin_i32_not(this.getBits()));
    }
}

// i32 クラス
public class i32 {
    private let bits: _m32;
    public constructor(raw: _m32) { this.bits = raw; }

    mocp public function getBits(): _m32 { return this.bits; }

    public operator+(other: i32): i32 {
        return new i32(__builtin_i32_add(this.getBits(), other.getBits()));
    }
    public operator-(other: i32): i32 {
        return new i32(__builtin_i32_sub(this.getBits(), other.getBits()));
    }
    public operator*(other: i32): i32 {
        return new i32(__builtin_i32_mul(this.getBits(), other.getBits()));
    }
    public operator/(other: i32): i32 {
        return new i32(__builtin_i32_div(this.getBits(), other.getBits()));
    }
    public operator%(other: i32): i32 {
        return new i32(__builtin_i32_mod(this.getBits(), other.getBits()));
    }
    public operator==(other: i32): boolean {
        return new boolean(__builtin_i32_eq(this.getBits(), other.getBits()));
    }
    public operator<(other: i32): boolean {
        return new boolean(__builtin_i32_lt(this.getBits(), other.getBits()));
    }
    public operator>(other: i32): boolean {
        return new boolean(__builtin_i32_gt(this.getBits(), other.getBits()));
    }
    public function toF32(): f32 {
        return new f32(__builtin_i32_to_f32(this.getBits()));
    }
    public function toU32(): u32 {
        return new u32(__builtin_i32_to_u32(this.getBits()));
    }
}

// 型エイリアス
type char = u32;
type string = Array<char>;

// Exception クラス
public class Exception {
    public let message: string;
    public constructor(msg: string) { this.message = msg; }
}

// Result<T> クラス
public class Result<T> {
    private let isSuccess: boolean;
    private let value: T;
    private let error: Exception;

    public constructor(success: boolean, val: T, err: Exception) {
        this.isSuccess = success;
        this.value = val;
        this.error = err;
    }

    public function unwrap(): T {
        if (this.isSuccess == new boolean(false)) {
            __builtin_panic("Fatal: Tried to unwrap an Error Result.");
        }
        return this.value;
    }
    public function isOk(): boolean { return this.isSuccess; }
    public function getError(): Exception { return this.error; }
}

// Option<T> クラス
public class Option<T> {
    private let hasValue: boolean;
    private let value: T;

    public constructor(has: boolean, val: T) {
        this.hasValue = has;
        this.value = val;
    }

    public function isSome(): boolean { return this.hasValue; }
    public function unwrap(): T {
        if (this.hasValue == new boolean(false)) {
            __builtin_panic("Fatal: Tried to unwrap a None Option.");
        }
        return this.value;
    }
}

// Array<T> クラス
public class Array<T> {
    private let ptr: _m32;
    public let length: i32;

    public constructor(size: i32) {
        this.length = size;
        // 注意：正確には size * sizeof<T>() バイトを確保する必要があるが、
        // 本参考実装では簡略化のため size * 4 バイト（全型4バイト固定）で確保する。
        // 実際の実装では __builtin_sizeof<T>() を使用すること。
        this.ptr = __builtin_malloc(__builtin_i32_mul(size.getBits(), __builtin_sizeof<i32>()));
    }

    mocp public function getPtr(): _m32 { return this.ptr; }

    // 注意：本参考実装は __builtin_mem_read32 / __builtin_mem_write32 を使用しているため
    // T が 32bit 以外のサイズを持つ型の場合は正しく動作しない。
    // 実際の実装では T のサイズに応じた読み書き命令を使用すること。
    public operator[](index: i32): T {
        return __builtin_mem_read32(this.ptr, __builtin_i32_mul(index.getBits(), __builtin_sizeof<i32>()));
    }
    public operator_set[](index: i32, value: T): void {
        __builtin_mem_write32(this.ptr, __builtin_i32_mul(index.getBits(), __builtin_sizeof<i32>()), value);
    }
    public function free(): void { __builtin_free(this.ptr); }
}

// Ptr<T> クラス
public class Ptr<T> {
    private let addr: _m32;
    public constructor(raw: _m32) { this.addr = raw; }

    mocp public function getAddr(): _m32 { return this.addr; }

    public function deref(): T {
        return __builtin_mem_read32(this.addr, new u32(0).getBits());
    }
    public function write(val: T): void {
        __builtin_mem_write32(this.addr, new u32(0).getBits(), val);
    }
    public function isNull(): boolean {
        return new boolean(__builtin_u32_eq(this.addr, new u32(0).getBits()));
    }
    public function free(): void { __builtin_free(this.addr); }
}

// Stdout クラス
public class Stdout {
    public constructor() {}
    public function write(s: string): void { __builtin_stdout_write(s); }
    public function writeLine(s: string): void {
        __builtin_stdout_write(s);
        __builtin_stdout_write("\n");
    }
}

// Stderr クラス
public class Stderr {
    public constructor() {}
    public function write(s: string): void { __builtin_stderr_write(s); }
    public function writeLine(s: string): void {
        __builtin_stderr_write(s);
        __builtin_stderr_write("\n");
    }
}

// Stdin クラス
public class Stdin {
    public constructor() {}
    public function readLine(): string { return __builtin_stdin_readline(); }
}
```

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
