# tools/

開発支援ツール群。

## spec-lint/

仕様書 Markdown（`doc/`）と YAML カタログ（`spec/catalog/`）の整合性を検査するリンタ。

```bash
npm run spec-lint              # 全ルール実行
npm run spec-lint -- --rules R1,R3  # 特定ルールのみ
```

違反が `error` レベルで 1 件でもあれば終了コード 1（CI フェイル）。詳細は [`spec-lint/README.md`](spec-lint/README.md) を参照。
