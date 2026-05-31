# doc/

mozaicScript の公式仕様書一式（Markdown）。

## ファイル

| ファイル | 内容 |
|---|---|
| `mozaicScript-spec.md` | 言語仕様。型システム（所有権・参照型含む）・文・式・アクセス修飾子・インポート・GPU カーネル・借用チェッカーパイプライン等 |
| `mozaicScript-corelib-spec.md` | コアライブラリ仕様。`i32` / `u32` / `f32` / `boolean` / `Array` / `Stdout` / GPU クラス等の API |
| `mozaicScript-ir-spec.md` | IR JSON フォーマット仕様。CPU IR（Part 1）および GPU IR（Part 2）の両フォーマットを収録 |
| `mozaicScript-engine-spec.md` | 実行エンジン（インタプリタ）仕様 |

## 仕様の機械検査

`spec/catalog/` に YAML 形式の仕様カタログ（SSOT）があり、`tools/spec-lint/`（`npm run spec-lint`）がこのディレクトリの Markdown と YAML の整合性を検査する。仕様書を編集したら `npm run spec-lint` で違反がないことを確認すること。
