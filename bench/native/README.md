# bench/native/

`speed_*.moz` ベンチマークと同一アルゴリズム・同一入力サイズで書いた手書きのネイティブ実装。

| ファイル | 対応ベンチ |
|---|---|
| `loopsum.c` / `loopsum.js` | `speed_loopsum.moz` |
| `fib.c` / `fib.js` | `speed_fib.moz` |
| `primes.c` / `primes.js` | `speed_primes.moz` |
| `collatz.c` / `collatz.js` | `speed_collatz.moz` |
| `matrix.c` / `matrix.js` | `speed_matrix.moz` |
| `mandelbrot.c` / `mandelbrot.js` | `speed_mandelbrot.moz` |

`bench/run_bench.sh` がこれらを `natC-O0/O2` / `nat-JS` 列として計測し、mozaicScript 生成コードとの速度差を表示する。チェックサム（出力）も全実行系で一致を確認する。
