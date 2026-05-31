# mozaicScript 仕様カタログ スキーマ定義

本ドキュメントは `spec/catalog/` 以下に置かれる YAML 正本（SSOT: Single Source of Truth）のスキーマと、AI / 仕様編集担当者がカタログを編集する際の運用ルールを定義する。

カタログの目的は「仕様書の Markdown 文書に分散して書かれていた事実を一箇所に集約し、機械（`tools/spec-lint`）が突き合わせ検査できるようにする」ことである。**矛盾の解消が目的ではなく、矛盾が機械的に検出可能になる状態を作ることが目的**である。

---

## 0. 共通原則

- フォーマットは **YAML** 1.2。各 `.yaml` ファイルのトップレベルはエントリの配列とする（**MUST**）。
- 1 エントリには必ず一意の `id` を持たせる（**MUST**）。
  - `id` は **`<カタログ>.<サブカテゴリ>.<名前>`** 形式の安定 kebab/dot キーとする。命名衝突や仕様上の改名に強くするため、人間可読な「現行の仕様名（`name` / `type` / `signature`）」とは分離する。
- 仕様文書（Markdown）への参照は **`<ファイル名>#<アンカー>`** 形式の文字列で与える。リンタが実在性を検証する。
  - 例: `mozaicScript-spec.md#9.11`、`mozaicScript-corelib-spec.md#6.6`
  - アンカーは Markdown の見出し本文中に **`#9.11` のような番号付き節**もしくは **見出しテキストの先頭一致**を許容する。リンタは両方を試して 1 つでも一致すれば OK とする。
- 既存の矛盾を勝手に直してはならない。複数箇所に食い違う記載があれば **両方を `referenced_in` 等に記録**し、リンタに検出させる。
- 仕様から一意に読めない事項は `OPEN-QUESTIONS.md` に列挙する。YAML 側で勝手に確定しない。

---

## 1. 命令カタログ `spec/catalog/builtins/*.yaml`

`__builtin_*` 形式の組み込み命令を 1 エントリ 1 命令で記述する。

### 1.1 ファイル分割粒度

機能グループ単位で 1 ファイルとする。現状の分割：

| ファイル | グループ | 対応する Markdown 節 |
|---|---|---|
| `numeric.yaml` | 数値演算（算術・比較） | 言語§9.1 |
| `logical.yaml` | 論理・ビット演算・シフト・ローテート・bit count | 言語§9.2 / §9.2.1 / §9.8 |
| `unary.yaml` | 単項演算（neg、float abs/sqrt 等含む） | 言語§9.5 / §9.9 |
| `transcendental.yaml` | 超越関数 | 言語§9.10 |
| `control.yaml` | 制御（if/while/panic） | 言語§9.3 |
| `memory.yaml` | メモリ管理・サイズ取得・ゼロ初期化 | 言語§9.4 / §9.6 |
| `conversion.yaml` | 型変換 | 言語§9.7 |
| `concurrency.yaml` | スレッド・プール・mutex・condvar・アトミック・fence | 言語§9.11 |
| `io.yaml` | 入出力 | 言語§9.12 |
| `gpu.yaml` | GPU ホスト連携 / GPU カーネル組み込み | 言語§14.4 / GPU IR §8 |

### 1.2 エントリスキーマ

```yaml
- id: builtin.atomic.load32              # 安定 ID（仕様改名後も不変に保つ）
  name: __builtin_atomic_load32          # 仕様上の正式名（現行スペル）
  group: concurrency.atomic              # 機能グループ
  params:                                # 引数（順序保持）
    - { name: ptr,   type: _m32 }
    - { name: order, type: _m32 }
  returns: _m32                          # 戻り型（無い場合は void）
  return_semantics: "32bit アトミックロード値"  # 戻り値の意味（M5 対策）。値を返す命令は必須
  defined_in: mozaicScript-spec.md#9.11   # この命令の定義の正本
  referenced_in:                          # 他の Markdown 内の言及箇所（参照のみ）
    - mozaicScript-ir-spec.md#並行プリミティブ
    - mozaicScript-corelib-spec.md#6.6
  notes: ""                              # 自由記述（任意）
```

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `id` | string | ✅ | 安定 ID。`builtin.<group>.<name>` 形式推奨 |
| `name` | string | ✅ | 仕様上の現行名（`__builtin_*` で始まる文字列） |
| `group` | string | ✅ | 機能グループのドット表記 |
| `params` | list | ✅ | 引数の順序付きリスト。空配列も可 |
| `params[].name` | string | ✅ | 引数名 |
| `params[].type` | string | ✅ | 引数型（`_m32` / `_m64` / `string` / `boolean` / クラス名・型エイリアス等） |
| `returns` | string | ✅ | 戻り型。`void` も明示 |
| `return_semantics` | string | △ | `returns != void` のとき必須（特に `group: concurrency.atomic` では R7 で必須化） |
| `defined_in` | string | ✅ | 定義の正本ファイル + アンカー |
| `referenced_in` | string[] | △ | 参照される側の Markdown（無くてもよい） |
| `notes` | string | ☐ | 自由記述 |

### 1.3 矛盾している場合の記録方法

複数文書で同名命令の引数や戻り型が異なる場合、**`name` / `params` / `returns` には正本（`defined_in` 側）の記述を入れる**。リンタは `referenced_in` の Markdown を読み、綴り・引数数・戻り型の一致を検査する（R1, R2）。

引数の意味論差（例: CAS が成功/失敗を返すか、旧値を返すか）は `return_semantics` に記録する。同名で意味が異なる命令が複数ある場合は **エントリを別々に作り、`notes` で関係性を相互参照**する。

---

## 2. IR ノードカタログ `spec/catalog/ir-nodes/*.yaml`

IR JSON 形式の AST ノードを 1 エントリ 1 ノード種別で記述する。

### 2.1 ファイル分割粒度

カテゴリ単位で 1 ファイルとする：`decl.yaml` / `expr.yaml` / `stmt.yaml` / `literal.yaml`。所有権拡張で追加されたノード（`BorrowExpr`）は適切なカテゴリのファイルに含める。

### 2.2 エントリスキーマ

```yaml
- id: irnode.BorrowExpr
  type: BorrowExpr                       # ノードの type フィールドの値
  category: expr                         # decl | expr | stmt | literal
  fields:
    - { name: isMut,        type: boolean, required: true }
    - { name: expr,         type: ASTNode, required: true }
    - { name: resolvedType, type: string,  required: true }
  defined_in: mozaicScript-ownership-spec.md#5.2
  must_appear_in_ir_node_list: true      # IR 仕様§3 のノード一覧に載るべきか
  referenced_in:
    - mozaicScript-ir-spec.md#1
  notes: "所有権拡張で追加。IR 仕様本体の§3 一覧に未収録（既知の不整合 M3）"
```

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `id` | string | ✅ | 安定 ID。`irnode.<NodeName>` 形式 |
| `type` | string | ✅ | ノードの `type` フィールドに入る文字列値（例 `BorrowExpr`） |
| `category` | string | ✅ | `decl` / `expr` / `stmt` / `literal` のいずれか |
| `fields` | list | ✅ | ノードのフィールド一覧 |
| `fields[].name` | string | ✅ | フィールド名 |
| `fields[].type` | string | ✅ | フィールド型（`string` / `boolean` / `ASTNode` / `ASTNode[]` / 具体ノード型名 など） |
| `fields[].required` | boolean | ✅ | 必須フィールドかどうか |
| `defined_in` | string | ✅ | このノードを定義している正本 |
| `must_appear_in_ir_node_list` | boolean | ✅ | `mozaicScript-ir-spec.md#3` のノード一覧表に出現すべきか。所有権拡張等で追加されたノードは `true` を入れて R3 で検出させる |
| `referenced_in` | string[] | ☐ | 参照箇所 |
| `notes` | string | ☐ | 自由記述 |

---

## 3. コアライブラリ API カタログ `spec/catalog/corelib/*.yaml`

コアライブラリのクラスメソッド・グローバル関数・型エイリアス等を記述する。

### 3.1 ファイル分割粒度

論理単位で 1 ファイル：

| ファイル | 内容 |
|---|---|
| `primitives.yaml` | `boolean` / `i32` / `u32` / `f32` / `i64` / `u64` / `f64` のメソッド群 |
| `containers.yaml` | `Result<T>` / `Option<T>` / `Array<T>` / `Ptr<T>` |
| `io.yaml` | `Stdout` / `Stderr` / `Stdin` クラスとグローバル関数 |
| `concurrency.yaml` | スレッド / プール / mutex / condvar / アトミック / `MemoryOrder` |
| `gpu.yaml` | `GpuBuffer` / `GpuKernel` / `GpuArgs` / グローバル関数（OPTIONAL） |

### 3.2 エントリスキーマ

```yaml
- id: corelib.u32.shr
  kind: method                           # method | global_fn | field | constructor
  owner: u32                             # method/field/constructor 時の所属クラス
  signature: "shr(shift: u32): u32"      # 仕様上のシグネチャ文字列
  defined_in: mozaicScript-corelib-spec.md#5.3
  lowers_to: builtin.u32.shr             # 対応する命令カタログ id（あれば。R6 で解決可能性を検査）
  notes: ""
```

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `id` | string | ✅ | 安定 ID |
| `kind` | string | ✅ | `method` / `global_fn` / `field` / `constructor` |
| `owner` | string | △ | `kind != global_fn` のとき必須 |
| `signature` | string | ✅ | 仕様書通りのシグネチャ |
| `defined_in` | string | ✅ | 正本 |
| `lowers_to` | string | ☐ | 対応する `builtin.*` カタログの id |
| `referenced_in` | string[] | ☐ | 他の Markdown での言及箇所 |
| `notes` | string | ☐ | 自由記述 |

---

## 4. AI 向け編集ルール

このカタログを **AI が将来編集する**ことを前提に、以下を厳守する。

1. **正本の編集**: 仕様書 Markdown と YAML カタログのどちらが正本かは、各エントリの `defined_in` が指す。`defined_in` を変更する場合は対応する Markdown も同時に更新せよ。
2. **矛盾の修正禁止**: ユーザーが明示的に「修正していい」と指示しない限り、両論併記のままにする。リンタの違反として残しておくのが正しい状態。
3. **id の不変性**: `id` フィールドは仕様上の名前が変わっても変えない。リンタは `id` を機械参照のキーとして使うため。`name`/`type`/`signature` だけを更新する。
4. **エントリ追加時**: 必ず適切なファイル（§1.1〜§3.1 の表）へ追加する。グループ判断に迷うときは `OPEN-QUESTIONS.md` に記録してから決める。
5. **コメントは英語/日本語どちらでもよい**が、フィールド値（特に `defined_in` のアンカー）は Markdown の実テキストと完全一致させる（リンタが文字列マッチで検証する）。
6. **YAML の構文**: 値に `:` を含む場合は必ずクォートする。リスト要素のフロー形式（`- { ... }`）と通常形式は混在可。
7. **未確定の判断**: `requires_design_decision: true` フラグを追加してよい。M4 / M6 のように複数の候補が両立する場合に使用する。リンタはこれを「設計判断待ち」として `report.json` に分類する。

---

## 5. 既知の矛盾と対応する YAML 上の扱い（クイックリファレンス）

| 既知矛盾 ID | YAML への記録の仕方 | 検出ルール |
|---|---|---|
| M1 | アトミック系命令を `defined_in: 言語§9.11` で記録し、コアライブラリ §6.6 / IR §3-脚注 / エンジン spec の言及箇所を `referenced_in` に列挙 | R1 (綴り) / R2 (引数数・型) |
| M2 | `__builtin_malloc` / `__builtin_mem_*` の `notes` に「言語§3.2 はバイト、本命令はワード」と明記 | R4 (アドレス単位語彙の対立検出) |
| M3 | `BorrowExpr` を `must_appear_in_ir_node_list: true` で登録。`FunctionDecl` の `isMut` フィールドも同様に IR ノードカタログに反映 | R3 (IR §3 ノード一覧との突き合わせ) |
| M4 | `notes` に「コアライブラリ §7.2 と IR §6 で AST 形が異なる」と記録 + `requires_design_decision: true` | レポート時にフラグで分類 |
| M5 | CAS 命令の `return_semantics` に CPU 系は「成功/失敗 (1/0)」、GPU 系は「旧値」と明記 | R7 (return_semantics 存在検査) + 自動レポート |
| M6 | コアライブラリ `Ptr<T>` の `notes` に「言語§14.3.1 / GPU IR §4 と T の許容範囲が異なる」を記録 + `requires_design_decision: true` | レポート時にフラグで分類 |
| M7 | `unary.yaml` 内に `__builtin_i32_neg` / `__builtin_f32_neg` / `__builtin_i64_neg` / `__builtin_f64_neg` を同一ファイル下で記録（散在の解消が SSOT 化の主目的） | R5 (相互参照) で言語§9.1/§9.9 → §9.5 への参照を間接検証 |

---

## 6. 変更履歴 (このスキーマ自体の)

- v1.0: 初版（M1〜M7 を検出可能にする最小限スキーマ）
