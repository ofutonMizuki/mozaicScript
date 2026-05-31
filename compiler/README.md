# compiler/

mozaicScript のコンパイラフロントエンド。`.moz`/`.moc` ソースを IR JSON（`*.ast.json`）に変換する。

## パイプライン

```
ソース (.moz/.moc)
  │
  ├─ lexer.ts      トークン列に分割
  ├─ parser.ts     再帰下降パース → 内部パースツリー (compiler/ast.ts: PExpr/PStmt/…)
  ├─ checker.ts    型検査 + 脱糖 → IR ノード (interpreter/types.ts: ASTNode/…)
  │                  ※ ここで compiler/ast.ts → interpreter/types.ts の橋渡しが起きる
  ├─ borrowcheck.ts 所有権・借用検証 + drop/__builtin_free の自動挿入
  ├─ optimizer.ts  IR レベル最適化（-O0/-O1/-O2）
  └─ gpulower.ts   gpu 関数を GPU IR (.gpu.json) に lower
```

インポートはトポロジカル順に解決される。依存先がすべてコンパイルされてから依存元を処理する。

## ファイル

| ファイル | 役割 |
|---|---|
| `lexer.ts` | トークナイザ |
| `parser.ts` | 再帰下降パーサ。`compiler/ast.ts` の型（`PExpr` 等）を返す |
| `ast.ts` | コンパイラ内部パースツリーの型定義（`interpreter/types.ts` と別物） |
| `checker.ts` | 型チェッカー + IR 生成。`Registry`（全クラス・関数の型情報）を構築 |
| `borrowcheck.ts` | 所有権・借用チェック。スコープ末尾に解放命令を自動挿入 |
| `optimizer.ts` | IR 最適化。プリミティブラッパーを構造的に検出してメソッドをインライン展開 |
| `gpulower.ts` | `isGpu=true` の関数を GPU IR 仕様に従って `.gpu.json` へ lower |
| `index.ts` | CLI エントリポイント |

## 使い方

```bash
npx ts-node compiler/index.ts [-O0|-O1|-O2] <entry.moz>
```
