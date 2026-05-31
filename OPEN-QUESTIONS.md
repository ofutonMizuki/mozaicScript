# OPEN-QUESTIONS

仕様カタログ YAML 化作業中に、仕様書 Markdown から一意に読み取れず判断保留としたメモ。設計者の判断を待ち、決定後に YAML/Markdown を更新する。

最終更新: 2026-05-31（M1〜M7 全件解決済を反映、spec-lint 違反 0）

## 解決履歴

- **M1 (アトミック命令名の食い違い)** — 2026-05-31: IR 仕様§3-並行プリミティブの `__builtin_atomic_*{32,64}` shorthand を展開、engine 仕様§6 builtins 例の sans-suffix 登録 (`__builtin_atomic_load` 等) を `*32`/`*64` 版に分割。**実装側 (`interpreter/builtins.ts`) の登録名変更は別タスク**。
- **M2 (アドレス単位 byte/word 混在)** — 2026-05-31: byte に統一。言語仕様§9.4 の `__builtin_malloc` を「バイトアドレスを返す」に修正、`__builtin_mem_*` の `offset` 単位もバイトに明示。コアライブラリ§6.6 の「ptr は word インデックス」「2 word 分のアライメント」を byte 表記に。**実装側 (HeapManager / `__builtin_mem_*` の word→byte セマンティクス変更) は別タスク**。
- **M3 (BorrowExpr / isMut 未収録)** — 2026-05-31: IR §3 ノード一覧に `BorrowExpr` を追加、§5 に `BorrowExpr` ノード定義を新設、`FunctionDecl` 例に `isMut` フィールド追加。engine spec の `ASTNode` union / `FunctionDecl` interface / `BorrowExpr` interface も追従。**実装側 (`interpreter/evaluator.ts` の `BorrowExpr` 評価追加) は別タスク**。
- **M4 (文字列リテラル展開の AST 形)** — 2026-05-31: コアライブラリ §7.2 の `operator_set[]` 連鎖形を正本に確定。IR §6 の `NewExpr.elements` フィールドは廃止。engine spec の `NewExpr` interface からも `elements` を削除。**実装側 (`interpreter/evaluator.ts` / バックエンド全般) の変更は別タスク**。
- **M5 (CAS の戻り値規約)** — 2026-05-31: 命名で差別化を採択。GPU 側 `gpuAtomicCas` → `gpuCompareExchange` (戻り値 `GpuCasResult` plain class)。CPU 側 `__builtin_atomic_cas32/64` は現状維持（成功=1/失敗=0）。**実装側 (`sample/gpu.moc`, シェーダ生成バックエンド) の変更は別タスク**。
- **M6 (Ptr<T> の許容 T)** — 2026-05-31: 共通 `Ptr<T>` に統一を採択。コアライブラリ §5.11 の T 制約を「数値型 + plain class」に緩和し、言語§14.3.1 / GPU IR §4 と整合。Q2 / Q5 もこの方針で解消。**実装側 (`Ptr<T>` の deref/write が plain class のフィールド単位アクセスを行う必要) の変更は別タスク**。
- **M7 (__builtin_*_neg の散在)** — 2026-05-31: §9.5 に集約。言語§9.1 から `__builtin_i64_neg` を削除、§9.9 から `__builtin_f64_neg` を削除、§9.5 にそれら 2 件を追加して i32/i64/f32/f64 の neg を 1 箇所に。**実装変更不要 (命令名は不変)**。

---

## カタログ運用に関わる未決事項

### Q1. ~~`__builtin_mem_read*` / `__builtin_mem_write*` の `offset` パラメータの単位~~ **[解決済 2026-05-31]**
- M2 確定 (byte に統一) に伴い解決。`offset` の単位はバイト。言語§9.4 の表に「`offset` の単位はバイト」を明示し、各 mem_read/write エントリの `notes` も更新済み。

### Q2. ~~`__builtin_atomic_cas*` の戻り値型 `_m32` か `boolean` か~~ **[解決済 2026-05-31]**
- M5 確定により、CPU 側は現状の `_m32`（成功=1, 失敗=0）を維持、corelib `atomicCas32/64` は boolean を返す（変換責務はコアライブラリ実装が負う）。GPU 側は別 API `gpuCompareExchange` として分離した。

### Q3. `__builtin_gpu_kernel_handle` の引数型
- **箇所**: GPU IR 仕様§8。
- **問題**: 仕様書の例は `args: ["vecAdd"]`（文字列リテラル）。CLAUDE.md の「既知の仕様未満項目」によれば実装は整数 ID を渡す。仕様と実装が乖離。
- **影響**: 設計判断（仕様を実装に合わせる/実装を仕様に合わせる）が必要。
- **暫定対応**: builtins/gpu.yaml の `notes` に既知差異を明記。リンタは型不整合として警告する仕組みは未実装（Q5 参照）。

### Q4. IR §3 ノード一覧表の「並行プリミティブ」項の表記
- **箇所**: IR 仕様§3 末尾の「並行プリミティブ（IR ノードなし）」 subsection。
- **問題**: `__builtin_atomic_load{32,64}` という brace 展開 shorthand が使われている。R1（綴り一致）で 10 件の違反になる。
- **影響**: 仕様書の可読性のための慣用表記だが、機械的に「綴り一致」を検査するなら shorthand を展開した形（`__builtin_atomic_load32` と `__builtin_atomic_load64` をそれぞれ列挙）にすべき。
- **暫定対応**: 違反を残し、AI による Markdown 整理タスクで対応する。

### Q5. ~~CPU `Ptr<T>` と GPU `ptr<T>` の同名問題~~ **[解決済 2026-05-31]**
- M6 確定により、共通 `Ptr<T>` に統一。コアライブラリ §5.11 の T 許容範囲を「数値型 + plain class」に緩和し、言語§14.3.1 / GPU IR §4 と整合させた。境界 (`GpuArgs.pushBufferMut`) はそのまま同一概念を渡せる。

---

## リンタの精度に関わる残課題

### Q6. R1 の shorthand 展開対応
- 現在の R1 は厳密文字列マッチ。`{32,64}` のような shorthand は綴り不一致として違反になる。
- ルールに「shorthand 展開器」を追加し、`name` が `__builtin_atomic_load32` のときは `__builtin_atomic_load{32,64}` も hit と判定する選択肢がある。ただし shorthand を許すと「ほんとに spec が古くて 32 しか存在しないつもり」を見逃すので、慎重さが必要。
- 暫定: 実装せず、shorthand は M1 シグナルとして残す。

### Q7. R2 の戻り型抽出の取りこぼし
- 現在の正規表現 `name\(...\)\s*(?::\s*([A-Za-z0-9_<>,\\s]+))?` は表セルの境界で取りこぼすことがある（特に `->` 矢印を使う Markdown 表現）。
- 例: IR §3-並行プリミティブの `__builtin_thread_spawn(fnName, args) -> _m64`。現在は `_m64` を戻り型として認識できる。問題なし。
- ただし `__builtin_thread_join` のような void 命令は `-> void` ではなく `void` が明示されないため、検査スキップ（戻り型未抽出）になっている。

### Q8. R5 の GitHub slug 解決
- Markdown 内の `[テキスト](file.md#anchor)` リンクは GitHub の slug 規則でアンカー化される（例: "1-凡例-および-適合性"）。現在の `resolveAnchor` は節番号 or 見出し先頭一致しか試さないため、解決できないケースが warning として出る。
- 暫定: warning に留め、エラーにはしない。

---

## カタログ網羅性に関わる残課題

### Q9. プリミティブクラスメソッドの未収録
- `corelib/primitives.yaml` は `i32` / `u32` / `f32` のメソッドはほぼ全て収録、`i64` / `u64` / `f64` は代表のみ。残りの `i64.toI32` 等を追加するには 30+ エントリの追記が必要。
- 暫定: M7 (neg) と `lowers_to` 検査に必要な分は収録済み。残りは AI による継続作業対象。

### Q10. GPU IR ノードカタログ
- 本作業のスコープは「CPU 側 IR ノード」のみ。GPU IR (`mozaicScript-gpu-ir-spec.md` §3〜§7) は別カタログ `spec/catalog/gpu-ir-nodes/` を将来追加すべきだが、本タスクでは未着手。
- 影響: GPU IR と CPU 側 IR の境界（`__builtin_gpu_dispatch` 等）の整合性は手動レビューに依存。

---

## ~~設計者判断が必要な既知矛盾~~ **[全件解決済 2026-05-31]**

すべて確定済。詳細は本書冒頭の「解決履歴」を参照。リンタの R4 / R7 / R8 は同種の不整合が再発しないか regression として検出するモードに切り替わっている。

---

## 仕様確定後に残っている実装タスク（次フェーズ）

仕様書 + YAML カタログ + リンタは整合状態（`npm run spec-lint` で違反 0）。以下は仕様確定に追従して**実装コード**を更新するタスク。

### 高優先度（バックエンド全体に影響）

- **M1 implementation**: [`interpreter/builtins.ts`](interpreter/builtins.ts) のアトミック命令テーブルを `__builtin_atomic_load` 等の sans-suffix 登録から `*_load32`/`*_load64` 等の正式名へ分割。`__builtin_atomic_fence` も追加。C / JS / WASM の各バックエンドも同様の lower 名で出力されているか確認。
- **M2 implementation**: HeapManager および `__builtin_mem_*` / `__builtin_malloc` を word-indexed から byte-indexed へ。各バックエンド (interpreter / codegen / jscodegen / wasmcodegen) の `offset` セマンティクスをバイト単位に統一。`bench/correct_*.moz` の挙動が変わらないことを `bench/run_tests.sh` で確認。
- **M3 implementation**: [`interpreter/types.ts`](interpreter/types.ts) の `ASTNode` union と `FunctionDecl` interface に `BorrowExpr` / `isMut` を追加（**engine spec の TypeScript と同期**）。[`interpreter/evaluator.ts`](interpreter/evaluator.ts) の `eval()` に `BorrowExpr` ケース追加（所有権§6.2.1 のゼロコスト借用 = `expr` を評価して返すだけでよい）。フロントエンド [`compiler/checker.ts`](compiler/checker.ts) は所有権拡張で対応済みのはずだが要確認。
- **M4 implementation**: [`interpreter/evaluator.ts:777-799`](interpreter/evaluator.ts#L777-L799) の `evalNewExpr` から `node.elements` 分岐削除。[`compiler/checker.ts`](compiler/checker.ts) の文字列リテラル展開を「`Array<u32>` 生成 + chained `operator_set[]` 呼び出し」を吐く形に変更。codegen / jscodegen / wasmcodegen の文字列展開コードも追従。

### 中優先度（GPU・ポインタ周り）

- **M5 implementation**: [`sample/gpu.moc`](sample/gpu.moc) の `gpuAtomicCas` を `gpuCompareExchange` に改名、戻り値型 `GpuCasResult` plain class を追加。[`wgslcodegen/`](wgslcodegen/) と [`mslcodegen/`](mslcodegen/) の lower で WGSL `atomicCompareExchangeWeak` / Metal の対応命令を struct 戻り値に lower。
- **M6 implementation**: コアライブラリの `Ptr<T>` を plain class 対応に拡張。`__builtin_sizeof<T>` を使って deref/write が plain class のサイズに応じてフィールド単位読み書きする実装。CPU 側 `Ptr<T>` と GPU 側 `ptr<T>` で同じ T が扱える境界を [`sample/gpu.moc`](sample/gpu.moc) の `GpuArgs.pushBufferMut` で揃える。

### 低優先度（仕様外、運用改善）

- リンタを CI に組み込み（GitHub Actions / pre-commit hook）。仕様書編集時に矛盾が増えないようにする。
- カタログ網羅性向上：`corelib/primitives.yaml` の `i64`/`u64`/`f64` の残メソッド (~30 件) を追記。
- GPU IR ノードカタログ `spec/catalog/gpu-ir-nodes/` を別途追加。
- YAML 正本からエンジン命令テーブル (`builtins.ts`) をコード生成するパスを追加し、M1 のような事故を構造的に排除。
