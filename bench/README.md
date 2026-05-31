# bench/

mozaicScript の正当性テストと速度ベンチマーク一式。

## ファイル構成

| ファイル | 役割 |
|---|---|
| `correct_*.moz` | 正当性テスト。4 バックエンド（interp/C/JS/WASM）の出力一致とオプティマイザ不変性を検証 |
| `speed_*.moz` | 速度ベンチ。interp / moz-JS / nat-JS / mozC-O0/O2 / natC-O0/O2 で計測 |
| `util.moz` | 全テスト共通の `printInt` 等ヘルパー（コアに整数→文字列変換がないため自作） |
| `run_tests.sh` | 正当性・回帰検査ランナー |
| `run_bench.sh` | 速度ベンチランナー（事前に `npm run build` が必要） |
| `native/` | 手書きネイティブ C/JS（速度比較ベースライン） |

## 実行

```bash
bash bench/run_tests.sh                  # 正当性テスト
bash bench/run_tests.sh --update-golden  # ゴールデン基準を更新
bash bench/run_bench.sh                  # 速度ベンチ
```

## 注意

生成物（`*.ast.json` / `*.c` / `*.js` / `*.wasm` / バイナリ）は `mktemp` の一時ディレクトリに出力される。このディレクトリにはソースのみを置く。`bench/golden/` はローカルのみ保持（gitignore）。
