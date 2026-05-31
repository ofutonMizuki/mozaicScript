# wgslcodegen/

GPU IR JSON → WGSL（WebGPU Shading Language）変換バックエンド。

## ファイル

| ファイル | 役割 |
|---|---|
| `codegen.ts` | 変換本体。`*.gpu.json` を読み込み WGSL ソースを生成 |
| `index.ts` | CLI エントリポイント |
| `run.js` | WebGPU 環境（Deno 1.39+ / Chrome / Node+`webgpu` パッケージ）でカーネルを実行するローダー。`<entry>.moz.gpu.test.json` をテストスペックとして消費 |

## 使い方

```bash
# コンパイル（*.gpu.json を生成）
npx ts-node compiler/index.ts <entry.moz>

# WGSL 生成
npx ts-node wgslcodegen/index.ts <entry.moz> [output.wgsl]

# WebGPU ランタイムで実行（gpu.test.json のテストスペックを使用）
node wgslcodegen/run.js <entry.moz>
```

GPU カーネルの CPU エミュレーションとの差分検証は `bench/correct_gpu.moz` を使う。
