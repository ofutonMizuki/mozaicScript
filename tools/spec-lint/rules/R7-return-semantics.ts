import { Catalog, Rule, SpecDocs, Violation } from "../types";

// R7: アトミック系命令 (group: concurrency.atomic) に return_semantics が記載されている。
// 既知矛盾 M5 検出の補助: CAS など同名で意味が異なる命令の戻り値規約を明示化する。
//
// 加えて、CAS 系については CPU/GPU で戻り値意味が逆方向であることを検出する。
export const rule: Rule = {
    id: "R7-return-semantics-present",
    description: "concurrency.atomic グループの命令に return_semantics が記載されている (M5 検出補助)",
    run(catalog: Catalog, _docs: SpecDocs): Violation[] {
        const violations: Violation[] = [];

        for (const b of catalog.builtins) {
            const atomicLike = b.group === "concurrency.atomic" ||
                b.group === "gpu.kernel.atomic";
            if (!atomicLike) continue;
            if (b.returns === "void") continue;
            if (!b.return_semantics || b.return_semantics.trim().length === 0) {
                violations.push({
                    ruleId: rule.id,
                    severity: "warning",
                    message: `命令 ${b.name} (${b.id}) は ${b.group} だが return_semantics が空 (M5 対策で必須化)`,
                    location: { catalog: b.id },
                    expected: "non-empty return_semantics",
                    actual: b.return_semantics ?? "<missing>",
                });
            }
        }

        // M5 regression 検査: 2026-05-31 解決済。GPU 側 CAS は gpuCompareExchange に改名され、
        // 同名 (Cas) で CPU/GPU が共存する状態は禁止 (MUST NOT)。
        // GPU 側 builtin に "Cas" を含む命令が再導入されたらエラー。
        const gpuCasViolators = catalog.builtins.filter(
            (b) => b.group === "gpu.kernel.atomic" && /Cas/.test(b.name)
        );
        if (gpuCasViolators.length > 0) {
            for (const b of gpuCasViolators) {
                violations.push({
                    ruleId: rule.id,
                    severity: "error",
                    message: `M5 regression: GPU 側に "Cas" を名前に含む命令 ${b.name} が存在する (gpuCompareExchange に改名済み。CPU 系 atomicCas と命名衝突するため禁止)`,
                    location: { catalog: b.id },
                    expected: "GPU 側は gpuCompareExchange(I32) のみ",
                    actual: b.name,
                });
            }
        }

        return violations;
    },
};
