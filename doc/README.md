# doc/

mozaicScript の公式仕様書一式（Markdown）。

## ファイル

| ファイル | 内容 |
|---|---|
| `mozaicScript-spec.md` | 言語仕様。型システム・文・式・アクセス修飾子・インポート等 |
| `mozaicScript-corelib-spec.md` | コアライブラリ仕様。`i32` / `u32` / `f32` / `boolean` / `Array` / `Stdout` 等の API |
| `mozaicScript-ir-spec.md` | IR JSON フォーマット仕様。コンパイラとバックエンドが共有するコントラクト |
| `mozaicScript-engine-spec.md` | 実行エンジン（インタプリタ）仕様 |
| `mozaicScript-ownership-spec.md` | 所有権・借用システム仕様（`&T` / `&mut T` / `BorrowExpr` / `isMut` 等） |
| `mozaicScript-gpu-ir-spec.md` | GPU IR 仕様。`gpu function` の lower 先 JSON スキーマとカーネル命令セット |

## 仕様の機械検査

`spec/catalog/` に YAML 形式の仕様カタログ（SSOT）があり、`tools/spec-lint/`（`npm run spec-lint`）がこのディレクトリの Markdown と YAML の整合性を検査する。仕様書を編集したら `npm run spec-lint` で違反がないことを確認すること。
