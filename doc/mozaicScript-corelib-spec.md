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
| `MemoryOrder` | アトミック操作のメモリ順序制約 |

必須グローバル関数（`print`, `eprint`, `readLine`, `panic`, スレッド関連）は §6 に記述する。

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
| `sin(): f64` | 正弦（ラジアン） |
| `cos(): f64` | 余弦（ラジアン） |
| `tan(): f64` | 正接（ラジアン） |
| `exp(): f64` | 指数関数（e^x） |
| `log(): f64` | 自然対数 |
| `pow(exponent: f64): f64` | 累乗 |
| `atan(): f64` | 逆正接 |
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
| `drop(): void` | メモリ解放 |

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

`mocp public let addr: _m32` — 内部アドレスフィールド（`.moc` 内専用）

### 5.12 `Stdout` / `Stderr`

標準出力・標準エラーへの書き出しを行うクラス。コンストラクタ引数に `_m32` を使用するため、直接インスタンス化は `.moc` ファイルからのみ可能（`.moz` コードの標準的な出力手段は §6.1 の `print` / `eprint`）。

| メソッド | 説明 |
|----------|------|
| `write(s: string): void` | 文字列を出力（改行なし） |
| `writeLine(s: string): void` | 文字列を出力して末尾に改行を付加 |

`mocp public let handle: _m32` — 内部ハンドル（`.moc` 内専用）

### 5.13 `Stdin`

標準入力から読み込むクラス。コンストラクタ引数に `_m32` を使用するため、直接インスタンス化は `.moc` ファイルからのみ可能（`.moz` コードの標準的な入力手段は §6.1 の `readLine`）。

| メソッド | 説明 |
|----------|------|
| `readLine(): string` | 標準入力から 1 行読み込む（末尾の改行は含まない） |

`mocp public let handle: _m32` — 内部ハンドル（`.moc` 内専用）

### 5.14 `MemoryOrder`

アトミック操作のメモリ順序制約を表す型。直接インスタンス化は `.moc` 内専用。ユーザーコードは §6.7 のグローバル関数で取得する。

| メソッド | 説明 |
|----------|------|
| `operator==(other: MemoryOrder): boolean` | 等価比較 |

`mocp public let bits: _m32` — 内部表現フィールド（`.moc` 内専用）

実装者が各定数に対応させるべき意味論は以下のとおり。

| 定数名 | C の対応値 | WASM 属性 | 用途 |
|--------|-----------|-----------|------|
| Relaxed | `memory_order_relaxed` | — | 順序制約なし（カウンタ加算等） |
| Acquire | `memory_order_acquire` | `acquire` | ロード側の取得（ロック獲得等） |
| Release | `memory_order_release` | `release` | ストア側の解放（ロック解放等） |
| AcqRel | `memory_order_acq_rel` | `acq_rel` | ロードとストアを同時に行う操作（CAS の成功時等） |
| SeqCst | `memory_order_seq_cst` | `seq_cst` | 逐次一貫性（最も強い保証、デフォルト推奨） |

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

共有メモリへのアクセスには原則としてミューテックスによる排他制御を用いなければならない（**MUST**）。ただし、§6.6 で定義するアトミック操作を用いてデータ競合なしに共有状態を操作する場合（ロックフリーアルゴリズム）は、ミューテックスは不要である。

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

ロックフリーアルゴリズムの実装に使用する。`ptr` は word インデックス（§6.6 の他の関数と同じメモリモデル）。

アトミック操作と非アトミックアクセスを同じアドレスに混在させてはならない（**MUST NOT**）。

**32bit 操作**

| 関数 | 説明 |
|------|------|
| `atomicLoad32(ptr: u32, order: MemoryOrder): u32` | 32bit アトミックロード |
| `atomicStore32(ptr: u32, val: u32, order: MemoryOrder): void` | 32bit アトミックストア |
| `atomicCas32(ptr: u32, expected: u32, desired: u32, successOrder: MemoryOrder, failureOrder: MemoryOrder): boolean` | 32bit Compare-And-Swap。`*ptr == expected` なら `desired` に書き換え `TRUE` を返す。異なれば何もせず `FALSE` を返す |
| `atomicFetchAdd32(ptr: u32, val: u32, order: MemoryOrder): u32` | 32bit アトミック加算（加算前の値を返す） |
| `atomicFetchSub32(ptr: u32, val: u32, order: MemoryOrder): u32` | 32bit アトミック減算（減算前の値を返す） |

**64bit 操作**（`ptr` は 64bit 値を収めるために 2 word 分のアライメントが必要）

| 関数 | 説明 |
|------|------|
| `atomicLoad64(ptr: u32, order: MemoryOrder): u64` | 64bit アトミックロード |
| `atomicStore64(ptr: u32, val: u64, order: MemoryOrder): void` | 64bit アトミックストア |
| `atomicCas64(ptr: u32, expected: u64, desired: u64, successOrder: MemoryOrder, failureOrder: MemoryOrder): boolean` | 64bit Compare-And-Swap |
| `atomicFetchAdd64(ptr: u32, val: u64, order: MemoryOrder): u64` | 64bit アトミック加算（加算前の値を返す） |
| `atomicFetchSub64(ptr: u32, val: u64, order: MemoryOrder): u64` | 64bit アトミック減算（減算前の値を返す） |

**フェンス**

| 関数 | 説明 |
|------|------|
| `atomicFence(order: MemoryOrder): void` | スタンドアロンのメモリフェンスを発行する。`order` には `Acquire`・`Release`・`AcqRel`・`SeqCst` のいずれかを使用する（`Relaxed` は無効） |

### 6.7 MemoryOrder 定数

`MemoryOrder` 値を取得するグローバル関数。ユーザーコードはこれを通じて `MemoryOrder` を入手する。

| 関数 | 意味 |
|------|------|
| `memoryOrderRelaxed(): MemoryOrder` | 順序制約なし |
| `memoryOrderAcquire(): MemoryOrder` | Acquire 順序 |
| `memoryOrderRelease(): MemoryOrder` | Release 順序 |
| `memoryOrderAcqRel(): MemoryOrder` | Acquire-Release（CAS の `successOrder` や `atomicFetchAdd` 等に使用） |
| `memoryOrderSeqCst(): MemoryOrder` | 逐次一貫性（最も強い保証。デフォルト推奨） |

**CAS ループの典型的な記述例:**
```typescript
// スピンロックの実装例（locked = 1、unlocked = 0）
public lock(ptr: u32): void {
    let acquired: boolean = FALSE;
    while (acquired.operatorNot()) {
        acquired = atomicCas32(ptr, new u32(0), new u32(1),
                               memoryOrderAcquire(), memoryOrderRelaxed());
    }
}

public unlock(ptr: u32): void {
    atomicStore32(ptr, new u32(0), memoryOrderRelease());
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

---

## 8. オプション拡張クラス

本セクションのクラスはすべてのプラットフォームで提供することを要求しない（**OPTIONAL**）。ただし、提供する場合は本仕様書が定める挙動に従わなければならない（**MUST**）。

### 8.1 `GpuBuffer`

GPU との間でデータを受け渡すためのバッファクラス。CPU 側からは Map/Unmap モデルでアクセスする。

GPU への所有権移譲は `unmap()` で行い、CPU から GPU へのデータコピーを最小化する。

- **UMA 環境**（Apple Silicon、統合グラフィクス等）では `mapWrite()` / `mapRead()` はゼロコピーでポインタを返す。`unmap()` 時はキャッシュフラッシュのみを行う。
- **ディスクリート GPU 環境**（PCIe 接続型 GPU）では `mapWrite()` は転送用一時領域を返す。`unmap()` 時に DMA 転送を自動発行する。

実装者はいずれの動作を採用するかを文書化しなければならない（**MUST**）。

`GpuBuffer` は直接インスタンス化できない。`gpuBufferCreate()` グローバル関数（§8.2）を用いて取得する。

| メソッド | 説明 |
|----------|------|
| `mapWrite<T>(): Ptr<T>` | CPU 書き込みアクセス権を要求する。戻り値は書き込み先の先頭アドレスを型 `T` の `Ptr` として返す。`unmap()` を呼ぶまで GPU はこのバッファを参照してはならない |
| `mapRead<T>(): Ptr<T>` | CPU 読み取りアクセス権を要求する。戻り値は型 `T` の `Ptr`。`unmap()` を呼ぶまで GPU はこのバッファを参照してはならない |
| `unmap(): void` | CPU のアクセス権を放棄し、GPU へ所有権を返還する。`mapWrite()` / `mapRead()` が呼ばれていない状態で呼ぶことは禁止（**MUST NOT**） |
| `byteSize(): u64` | バッファのバイトサイズを返す |
| `drop(): void` | バッファを破棄してメモリを解放する。自動挿入された `drop()` 呼び出し時にバッファがマッピング状態であった場合は、安全のために自動的に `unmap()` を行ってから解放しなければならない（**MUST**） |

`mocp public let handle: _m64` — 内部ハンドル（`.moc` 内専用）

### 8.2 GPU グローバル関数（バッファ・能力照会）

| 関数 | 説明 |
|------|------|
| `gpuBufferCreate(byteSize: u64): GpuBuffer` | 指定バイトサイズの GPU バッファを確保する |
| `gpuIsAvailable(): boolean` | GPU バックエンドが利用可能かどうかを返す。`FALSE` を返す環境では他の GPU 関数を呼んではならない（**MUST NOT**） |

### 8.3 GPU カーネルディスパッチ API

`gpu` 修飾子付き関数（言語仕様書 §14）を GPU 上で実行するためのホスト側 API。

#### 8.3.1 `GpuKernel`

`gpu` 関数への型付き参照。直接インスタンス化することはできず、コンパイラが `gpu` 関数宣言ごとにグローバルスコープに同名の `GpuKernel` 定数を自動生成する（**MUST**）。例えば

```typescript
gpu function vecAdd(out: Ptr<f32>, a: Ptr<f32>, b: Ptr<f32>, n: u32): void { ... }
```

を宣言すると、コンパイラは次の宣言を暗黙に追加する。

```typescript
public let vecAdd: GpuKernel;   // 同名の GpuKernel 定数
```

ユーザコードは `vecAdd` を `gpuDispatch()` の第 1 引数として直接渡せる。

| メソッド | 説明 |
|----------|------|
| `name(): string` | カーネル関数名を返す（デバッグ用） |
| `workgroupSizeX(): u32` | 宣言された `workgroupSize` の X 次元値を返す |
| `workgroupSizeY(): u32` | Y 次元値を返す（未指定時は `1`） |
| `workgroupSizeZ(): u32` | Z 次元値を返す（未指定時は `1`） |

`mocp public let handle: _m64` — 内部ハンドル

#### 8.3.2 `GpuArgs`

`gpuDispatch()` に渡す引数束。`gpu` 関数の引数列を順に格納する型付きビルダー。

```typescript
let args: GpuArgs = new GpuArgs();
args.pushBufferMut(&mut outBuf); // Ptr<T> 引数（GpuBuffer の先頭アドレスに lower）
args.pushBuffer(&aBuf);
args.pushBuffer(&bBuf);
args.pushU32(new u32(1024));     // スカラー引数
```

| メソッド | 説明 |
|----------|------|
| `pushBuffer(buf: &GpuBuffer): void` | 読み取り専用バッファ参照を引数として追加。カーネル側の `Ptr<T>` 引数に対応 |
| `pushBufferMut(buf: &mut GpuBuffer): void` | 書き込み用バッファ参照を引数として追加。カーネル側の `Ptr<T>` 引数に対応 |
| `pushI32(v: i32): void` / `pushU32(v: u32): void` / `pushI64(v: i64): void` / `pushU64(v: u64): void` | 整数スカラーを追加 |
| `pushF32(v: f32): void` / `pushF64(v: f64): void` | 浮動小数点スカラーを追加 |
| `pushBoolean(v: boolean): void` | 真偽値スカラーを追加 |
| `count(): u32` | 現在登録されている引数数 |
| `clear(): void` | 内部バッファを空にする（再利用用） |

引数の **順序・型は宣言時のカーネル関数シグネチャと一致しなければならない**（**MUST**）。ランタイムは型不一致を検出した場合パニックを発行する（**MUST**）。

#### 8.3.3 ディスパッチ関数

| 関数 | 説明 |
|------|------|
| `gpuDispatch(kernel: GpuKernel, args: GpuArgs, gridX: u32, gridY: u32, gridZ: u32): void` | 指定カーネルを `gridX × gridY × gridZ` 個のワークグループでディスパッチする。実際の起動スレッド総数は `grid * workgroupSize` 個 |
| `gpuDispatch1D(kernel: GpuKernel, args: GpuArgs, gridX: u32): void` | `gpuDispatch(kernel, args, gridX, new u32(1), new u32(1))` のシンタックスシュガー |
| `gpuSync(): void` | キューに積まれた全 GPU ディスパッチの完了を待機する。CPU ホストから GPU 結果バッファを `mapRead()` する前に呼ぶこと（**MUST**） |
| `gpuFlush(): void` | 未送出のディスパッチを GPU に送信するが、完了は待たない |

#### 8.3.4 実行モデル

- `gpuDispatch()` は **非同期**である。呼び出しから戻った時点でカーネル実行の完了は保証されない。
- ディスパッチ完了を確実に待つ場合は `gpuSync()` を使う。
- 同一バッファに対する読み書きの順序保証は、同一キュー内でのディスパッチ順 + `gpuSync()` のみによる。複数バッファ間の依存性追跡は実装定義（**IMPLEMENTATION-DEFINED**）。

#### 8.3.5 GPU 関数の直接呼び出し禁止

`gpu` 関数を通常の関数呼び出し構文（`vecAdd(out, a, b, n)`）で呼ぶことは禁止する（**MUST NOT**）。コンパイラはこれを検出してコンパイルエラーを発する（**MUST**）。GPU 関数は必ず `gpuDispatch()` 経由で起動しなければならない。
