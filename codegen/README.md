# codegen/

IR JSON → C ソースコード変換バックエンド。

## ファイル

| ファイル | 役割 |
|---|---|
| `codegen.ts` | 変換本体。`loadAST()` で依存 `*.ast.json` を再帰収集し、C ソースを生成 |
| `index.ts` | CLI エントリポイント |

## 使い方

```bash
npx ts-node codegen/index.ts <entry.moz> [output.c]
gcc -o <bin> <output.c> -lm -lpthread && ./<bin>
```

`-lpthread` はスレッド命令（`__builtin_thread_*`）が pthreads に lower されるため必須。

## 注意

`npm run build`（tsconfig）の型チェック対象に含まれる。他のバックエンドと異なり `dist/codegen/` にビルドされる。
