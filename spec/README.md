# spec/

仕様書（`doc/` の Markdown）の SSOT（Single Source of Truth）となる YAML カタログ。`tools/spec-lint/` がこのカタログと Markdown を突き合わせて整合性を機械検査する。

## ディレクトリ構成

```
spec/catalog/
├── SCHEMA.md          カタログの YAML スキーマ定義と AI 向け編集ルール
├── builtins/          __builtin_* 組み込み命令カタログ
├── ir-nodes/          IR AST ノード種別カタログ
└── corelib/           コアライブラリ API カタログ
```

### builtins/

`__builtin_*` 命令を機能グループ別に 1 ファイル 1 グループで記述。

| ファイル | グループ |
|---|---|
| `numeric.yaml` | 算術・比較（§9.1） |
| `logical.yaml` | 論理・ビット演算・シフト・ローテート（§9.2） |
| `unary.yaml` | 単項演算・neg・abs/sqrt 等（§9.5） |
| `transcendental.yaml` | 超越関数（§9.10） |
| `control.yaml` | 制御（§9.3） |
| `memory.yaml` | メモリ管理・ゼロ初期化（§9.4/§9.6） |
| `conversion.yaml` | 型変換（§9.7） |
| `concurrency.yaml` | スレッド・mutex・condvar・アトミック（§9.11） |
| `io.yaml` | 入出力（§9.12） |
| `gpu.yaml` | GPU ホスト連携・カーネル組み込み（§14.4） |

### ir-nodes/

IR JSON の AST ノード種別を `decl.yaml` / `expr.yaml` / `stmt.yaml` / `literal.yaml` に分類して記述。

### corelib/

コアライブラリのクラスメソッド・グローバル関数・型エイリアスを記述。`primitives.yaml` / `containers.yaml` / `io.yaml` / `concurrency.yaml` / `gpu.yaml`。

## 編集ルール

- YAML の `id` フィールドは安定キー。仕様がリネームされても変えない（`name`/`signature` のみ更新）
- 仕様書と YAML の矛盾は勝手に修正しない。矛盾は `OPEN-QUESTIONS.md` に記録し、リンタに検出させる
- 詳細なスキーマ定義は `spec/catalog/SCHEMA.md` を参照
