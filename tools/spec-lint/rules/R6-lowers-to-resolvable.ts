import { Catalog, Rule, SpecDocs, Violation } from "../types";

// R6: コアライブラリ API の lowers_to が命令カタログの実在 id を指す。
// コアライブラリのメソッド ⇔ 命令の対応の穴を発見できる。
export const rule: Rule = {
    id: "R6-lowers-to-resolvable",
    description: "コアライブラリ API の lowers_to が命令カタログの実在 id を指す",
    run(catalog: Catalog, _docs: SpecDocs): Violation[] {
        const violations: Violation[] = [];
        const builtinIds = new Set(catalog.builtins.map((b) => b.id));

        for (const c of catalog.corelib) {
            if (!c.lowers_to) continue;
            if (!builtinIds.has(c.lowers_to)) {
                violations.push({
                    ruleId: rule.id,
                    severity: "error",
                    message: `corelib ${c.id} の lowers_to "${c.lowers_to}" が命令カタログに存在しない`,
                    location: { catalog: c.id },
                    expected: "命令カタログ (spec/catalog/builtins/) に同一 id のエントリ",
                    actual: c.lowers_to,
                });
            }
        }

        return violations;
    },
};
