# sample/

コアライブラリのソース（`.moc`）とサンプルプログラム（`.moz`）。

## ファイル

| ファイル | 種別 | 内容 |
|---|---|---|
| `core.moc` | コアライブラリ | `boolean` / `i32` / `u32` / `f32` / `i64` / `u64` / `f64` / `Array<T>` / `Ptr<T>` / `Stdout` / `Stderr` 等の基本型。`__builtin_*` 命令を直接実装する特権ファイル |
| `gpu.moc` | GPU 拡張ライブラリ | `GpuBuffer` / `GpuKernel` / `GpuArgs` / `gpuDispatch` 等。`__builtin_gpu_*` で実装。`.moz` から `import "./gpu.moc" as *;` で利用 |
| `main.moz` | サンプル | 言語仕様の主要機能を網羅したサンプルプログラム（FizzBuzz 等） |
| `geometry.moz` | サンプル | 所有権・借用システムの使用例（`Vec2` を使ったベクタ演算） |

## 依存関係

`bench/run_tests.sh` はテスト実行時に `core.moc` と `gpu.moc` を一時ディレクトリにコピーして使用する。これらは全テストケースの基盤となるため、このディレクトリから移動させてはならない。
