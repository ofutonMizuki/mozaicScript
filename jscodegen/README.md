# jscodegen/

IR JSON → JavaScript 変換バックエンド。生成した JS は `node` で直接実行できる。

## ファイル

| ファイル | 役割 |
|---|---|
| `codegen.ts` | 変換本体。`loadAST()` で依存 `*.ast.json` を再帰収集し、JS ソースを生成 |
| `index.ts` | CLI エントリポイント |

## 使い方

```bash
npx ts-node jscodegen/index.ts <entry.moz> [output.js]
node <output.js>
```

## 注意

`npm run build`（tsconfig の `include`）の型チェック対象外。`ts-node` で直接実行する。
