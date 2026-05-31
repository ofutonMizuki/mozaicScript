# mslcodegen/

GPU IR JSON → MSL（Metal Shading Language）変換バックエンド（Mac / iOS 向け）。

## ファイル

| ファイル | 役割 |
|---|---|
| `codegen.ts` | 変換本体。`*.gpu.json` を読み込み MSL ソースを生成 |
| `index.ts` | CLI エントリポイント |
| `run.swift` | Metal フレームワーク経由でカーネルを実行するローダー。`<entry>.moz.gpu.test.json` をテストスペックとして消費 |

## 使い方

```bash
# コンパイル（*.gpu.json を生成）
npx ts-node compiler/index.ts <entry.moz>

# MSL 生成
npx ts-node mslcodegen/index.ts <entry.moz> [output.metal]

# Mac で実行（gpu.test.json のテストスペックを使用）
swift mslcodegen/run.swift <entry.moz>
```

実行には Mac と Xcode Command Line Tools が必要。
