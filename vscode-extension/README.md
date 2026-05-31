# vscode-extension/

VS Code 向け mozaicScript シンタックスハイライト拡張。コンパイラ・ランタイムとは独立したパッケージ。

## 対応ファイル

`.moz`（ユーザーコード）と `.moc`（コアライブラリ）の両方に対応。

## ファイル

| ファイル | 役割 |
|---|---|
| `syntaxes/mozaicscript.tmLanguage.json` | TextMate グラマー定義（ハイライトルール本体） |
| `language-configuration.json` | コメント・ブラケット・オートクロージング等の設定 |
| `package.json` | 拡張マニフェスト（言語 ID: `mozaicscript`） |
| `mozaicscript-syntax-0.1.0.vsix` | パッケージ済み拡張ファイル |

## インストール

```bash
code --install-extension vscode-extension/mozaicscript-syntax-0.1.0.vsix
```
