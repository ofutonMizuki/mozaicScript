import { Catalog, Rule, SpecDocs, Violation } from "../types";
import { parseSpecRef, resolveAnchor, sectionText } from "../loader";

// R8: 設計判断を要する矛盾を明示的にレポートする補助ルール。
// (M4) 文字列リテラル展開: コアライブラリ §7.2 (operator_set[] 連鎖) vs IR §6 (elements 配列) の非互換
// (M6) Ptr<T> の許容 T: コアライブラリ §5.11 / 言語§14.3.1 / GPU IR §4 の食い違い
// (M7) __builtin_*_neg の散在
//
// これらは YAML だけで「正本どちらに寄せる」と決められないため requires_design_decision: true でレポートする。
export const rule: Rule = {
    id: "R8-design-decisions",
    description: "設計者判断を要する既知矛盾 (M4 / M6 / M7) を report.json に分類してレポートする",
    run(catalog: Catalog, docs: SpecDocs): Violation[] {
        const violations: Violation[] = [];

        // ── M4: 文字列リテラル展開 AST 形 (regression 検査) ───────────────────
        // 2026-05-31 解決: operator_set[] 連鎖に統一済み。IR §6 から elements を削除。
        // 再発防止のため、IR §6 / engine spec NewExpr に "elements" が再び現れたらエラー。
        const corelib = docs.get("mozaicScript-corelib-spec.md");
        const ir = docs.get("mozaicScript-ir-spec.md");
        const engine = docs.get("mozaicScript-engine-spec.md");
        if (ir) {
            const ir6 = resolveAnchor(ir, "6");
            if (ir6) {
                const irBody = sectionText(ir, ir6);
                if (/"elements"\s*:/.test(irBody)) {
                    violations.push({
                        ruleId: rule.id,
                        severity: "error",
                        message: "M4 regression: IR §6 に elements フィールドが再導入されている (operator_set[] 連鎖形を正本としたため禁止)",
                        location: { spec: "mozaicScript-ir-spec.md#6", line: ir6.line },
                        expected: "elements フィールド無し",
                        actual: "'elements' が IR §6 本文に出現",
                    });
                }
            }
        }
        if (engine) {
            if (/elements\?\s*:\s*RawLiteral/.test(engine.text)) {
                violations.push({
                    ruleId: rule.id,
                    severity: "error",
                    message: "M4 regression: engine spec NewExpr interface に elements が再導入されている",
                    location: { spec: "mozaicScript-engine-spec.md#3" },
                    expected: "NewExpr interface に elements 無し",
                    actual: "'elements?: RawLiteral[]' が engine spec に出現",
                });
            }
        }

        // ── M6: Ptr<T> の許容 T の整合性 regression 検査 ────────────────────
        // 2026-05-31 解決: 共通 Ptr<T> に統一 (制約緩和)。
        // コアライブラリ §5.11 が「単一 _m32/_m64 フィールドのクラスに限定」と書き戻された場合エラー。
        const spec = docs.get("mozaicScript-spec.md");
        if (corelib) {
            const corelibPtr = resolveAnchor(corelib, "5.11");
            if (corelibPtr) {
                const bCorelib = sectionText(corelib, corelibPtr);
                // 「単一の _m32 ... フィールドを持つクラスに限定」のような restrictive 文言を検出
                if (/単一の `?_m32`?[^。]*フィールドを持つクラスに限定/.test(bCorelib)) {
                    violations.push({
                        ruleId: rule.id,
                        severity: "error",
                        message: "M6 regression: コアライブラリ §5.11 で Ptr<T> の T が「単一 _m32/_m64 フィールドのクラス」に再制限されている (言語§14.3.1 / GPU IR §4 と整合する形へ緩和済み)",
                        location: { spec: "mozaicScript-corelib-spec.md#5.11", line: corelibPtr.line },
                        expected: "数値型 + plain class を許容",
                        actual: "_m32/_m64 単一フィールドへの制限",
                    });
                }
            }
        }

        // ── M7: __builtin_*_neg が §9.5 に集約されているか (regression 検査) ──
        // 2026-05-31 解決: §9.5 に集約済。
        // (a) catalog の defined_in が §9.5 以外を指していたらエラー。
        // (b) 言語§9.1 / §9.9 本文に `__builtin_*_neg` が現れていたらエラー。
        const negEntries = catalog.builtins.filter((b) => b.group === "unary.neg");
        for (const e of negEntries) {
            const p = parseSpecRef(e.defined_in);
            if (p && p.anchor !== "9.5") {
                violations.push({
                    ruleId: rule.id,
                    severity: "error",
                    message: `M7 regression: 単項否定命令 ${e.name} の defined_in が §9.5 以外 (${e.defined_in})`,
                    location: { catalog: e.id, spec: e.defined_in },
                    expected: "mozaicScript-spec.md#9.5",
                    actual: e.defined_in,
                });
            }
        }
        if (spec) {
            for (const sectionAnchor of ["9.1", "9.9"]) {
                const sec = resolveAnchor(spec, sectionAnchor);
                if (!sec) continue;
                const body = sectionText(spec, sec);
                const negMatches = body.match(/__builtin_[a-z0-9]+_neg/g);
                if (negMatches) {
                    for (const m of new Set(negMatches)) {
                        violations.push({
                            ruleId: rule.id,
                            severity: "error",
                            message: `M7 regression: ${m} が言語仕様§${sectionAnchor} に存在する (§9.5 に集約すべき)`,
                            location: {
                                spec: `mozaicScript-spec.md#${sectionAnchor}`,
                                line: sec.line,
                            },
                            expected: "§9.5 のみに定義",
                            actual: `§${sectionAnchor} に ${m}`,
                        });
                    }
                }
            }
        }

        return violations;
    },
};
