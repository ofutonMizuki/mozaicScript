# spec-lint — mozaicScript 仕様書突き合わせリンタ

`spec/catalog/` の YAML 正本（命令カタログ / IR ノードカタログ / コアライブラリ API カタログ）と、`doc/` の Markdown 仕様書 6 本を突き合わせ、両者が矛盾していないかを機械的に検査するツール。

## 実行方法

```bash
# 全ルール実行
npm run spec-lint

# 特定ルールのみ実行（接頭辞マッチ）
npm run spec-lint -- --rules R1,R3

# 直接実行
npx ts-node tools/spec-lint/index.ts
```

実行結果は以下に出力される。
- 標準出力: 人間可読サマリ + 違反一覧
- `tools/spec-lint/report.json`: 機械可読 JSON

違反が 1 件でも `error` レベルで存在すれば終了コードは `1`（CI フェイル）。`warning` / `info` / `design-decision` のみであれば `0` を返す。

---

## ディレクトリ構成

```
tools/spec-lint/
├── README.md           本書
├── index.ts            エントリ
├── loader.ts           YAML / Markdown のロードと見出し解決
├── types.ts            共通型
├── report.json         実行結果（生成物）
└── rules/
    ├── R1-name-spelling.ts
    ├── R2-signature-consistency.ts
    ├── R3-ir-node-coverage.ts
    ├── R4-address-unit-lexicon.ts
    ├── R5-cross-ref-resolvable.ts
    ├── R6-lowers-to-resolvable.ts
    ├── R7-return-semantics.ts
    └── R8-design-decisions.ts
```

---

## 実装ルール一覧

| ID | 内容 | 既知矛盾対応 | severity の主な値 |
|----|------|--------------|-------------------|
| `R1-name-spelling` | カタログ内の命令名 / IR ノード `type` が `referenced_in` の各 Markdown 該当節に出現するか | M1（綴り）/ E1 | error |
| `R2-signature-consistency` | 同一命令の引数数・型・戻り型が定義側と参照側で一致するか。エンジン仕様内の `__builtin_atomic_*` 登録名がカタログに存在するかも検査 | M1 / E1 | error, warning |
| `R3-ir-node-coverage` | `must_appear_in_ir_node_list: true` の IR ノードが IR §3 一覧 + engine 仕様 `ASTNode` union に出現するか。`FunctionDecl.isMut` の有無も検査 | M3 / E2 | error |
| `R4-address-unit-lexicon` | 全 Markdown 中の「バイトアドレス / ワードアドレス / word インデックス」等の語彙を抽出し、混在を検出 | M2 | error |
| `R5-cross-ref-resolvable` | YAML の `defined_in` / `referenced_in` および Markdown 内 `[text](file.md#anchor)` リンクが実在見出しを指すか | 全般 | error, warning |
| `R6-lowers-to-resolvable` | コアライブラリ API の `lowers_to` フィールドが命令カタログの実在 `id` を指すか | M1 関連 | error |
| `R7-return-semantics-present` | `concurrency.atomic` グループの命令に `return_semantics` が記載されているか。CAS の CPU/GPU 規約逆方向の検出も含む | M5 | warning, design-decision |
| `R8-design-decisions` | 設計判断を要する矛盾 (M4 / M6 / M7) を `requires_design_decision: true` で分類してレポート | M4 / M6 / M7 | design-decision, info |

> 注: 各ルールは `tools/spec-lint/rules/R*.ts` に独立したファイルとして実装されている。`index.ts` の `ALL_RULES` 配列にエクスポートを追加するだけで新ルールを差し込める（プラグイン的構成）。

---

## ルール拡張方法

1. `tools/spec-lint/rules/R<新ID>-<目的>.ts` を作成。
   ```ts
   import { Rule } from "../types";

   export const rule: Rule = {
       id: "R9-my-new-rule",
       description: "...",
       run(catalog, docs) {
           const violations = [];
           // ...
           return violations;
       },
   };
   ```
2. `tools/spec-lint/index.ts` の冒頭に `import { rule as R9 } from "./rules/R9-..."` を追加し、`ALL_RULES` 配列に加える。
3. `README.md`（本書）のルール一覧表に追記。
4. SCHEMA.md の「§5 既知の矛盾と対応する YAML 上の扱い」表に該当行を追記。

ルール内で必要な共通ヘルパー（`parseSpecRef`, `resolveAnchor`, `sectionText`）は `loader.ts` にある。

---

## 矛盾の修正は行わない

このリンタは**検出と報告のみ**を行う。`error` レベルの違反が出ても自動修正は実装しない。直すかどうか、どちらに寄せるかは設計者の判断であり、それを記録するために `requires_design_decision: true` フラグを `report.json` に出している。

人間（または AI）が仕様書 Markdown と YAML カタログのどちらか・両方を編集することで違反を解消する。詳細な編集ルールは `spec/catalog/SCHEMA.md` の §4 を参照。

---

## report.json のスキーマ

```jsonc
{
  "summary": {
    "total": 29,                       // 違反総数
    "errors": 23,
    "warnings": 0,
    "designDecisions": 4,
    "byRule": {
      "R1-name-spelling": 11,
      "R2-signature-consistency": 5,
      "R3-ir-node-coverage": 4,
      "R4-address-unit-lexicon": 3,
      "R7-return-semantics-present": 1,
      "R8-design-decisions": 5
    }
  },
  "violations": [
    {
      "ruleId": "R3-ir-node-coverage",
      "severity": "error",             // "error" | "warning" | "info" | "design-decision"
      "message": "...",
      "location": {
        "catalog": "irnode.BorrowExpr",          // YAML 上の id (任意)
        "spec":   "mozaicScript-ir-spec.md#3",   // <file>#<anchor> (任意)
        "line":   30                              // 1-based (任意)
      },
      "expected": "...",
      "actual":   "...",
      "requires_design_decision": false
    }
  ]
}
```

---

## 既知矛盾 vs 検出結果の対応表

**全件解決済（2026-05-31 時点）**。`npm run spec-lint` の違反件数は 0。各ルールは regression 検出モードで動作している（同種の矛盾が再導入されたら error）。

| 既知矛盾 | 解決方針 | regression 検出ルール |
|---|---|---|
| M1（アトミック命令名の食い違い） | IR §3-並行プリミティブの `{32,64}` shorthand を展開、engine 仕様の sans-suffix 登録を `*32/*64` に分割 | R1（綴り一致）/ R2（engine spec scan） |
| M2（アドレス単位 byte/word 混在） | byte に統一 | R4（word 系語彙の再導入を検出） |
| M3（BorrowExpr / isMut 未収録） | IR §3 一覧と §5 ノード定義に追加、engine spec も追従 | R3 |
| M4（文字列リテラル展開の AST 形） | `operator_set[]` 連鎖を正本、`NewExpr.elements` を廃止 | R8（`elements` の再導入を検出） |
| M5（CAS の戻り値規約が CPU/GPU で逆方向） | GPU 側を `gpuCompareExchange` に改名し戻り値を struct に | R7（GPU 側に `Cas` を含む命令の再登場を検出） |
| M6（Ptr<T> の許容 T が複数仕様で異なる） | 共通 `Ptr<T>` に統一（T 制約を緩和） | R8（§5.11 が「単一 _m32/_m64 ... に限定」へ書き戻されたら検出） |
| M7（`__builtin_*_neg` が複数節に分散） | §9.5 に集約 | R8（§9.1 / §9.9 への neg 命令再記載を検出） |

仕様確定後に残っている**実装タスク**（バックエンドコードや HeapManager の変更等）は [OPEN-QUESTIONS.md](../../OPEN-QUESTIONS.md) を参照。
