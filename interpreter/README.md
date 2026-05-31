# interpreter/

IR JSON（`*.ast.json`）をツリーウォーキングで直接実行するインタプリタ。

## ファイル

| ファイル | 役割 |
|---|---|
| `evaluator.ts` | メイン評価器。`*.ast.json` を読み込み、インポートを再帰解決して `main()` を実行 |
| `environment.ts` | レキシカルスコープチェーン（`Environment.extend()` で子スコープを生成） |
| `values.ts` | ランタイム値型（`PrimitiveValue` / `ObjectValue` / `VoidValue`） |
| `builtins.ts` | `__builtin_*` 組み込み命令の実装。`HeapManager`・`ThreadManager`・`GpuManager`（CPU エミュレーション）を含む |
| `types.ts` | IR JSON のスキーマ型定義（`ASTNode`・`MozaicScriptAST` 等）。**全バックエンドが共有するコントラクト** |
| `index.ts` | CLI エントリポイント |

## 使い方

```bash
# まずコンパイル
npx ts-node compiler/index.ts <entry.moz>
# 実行
npx ts-node interpreter/index.ts <entry.moz.ast.json>
```

## interpreter/types.ts について

このファイルは IR の型定義であり、コンパイラ・インタプリタ・全コード生成バックエンドが依存する。変更すると 5 つのディレクトリすべてに影響する。
