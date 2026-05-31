import { Catalog, Rule, SpecDocs, Violation } from "../types";
import { parseSpecRef, resolveAnchor, sectionText } from "../loader";

// R1: 命令名 / ノード type が referenced_in の Markdown 該当節に出現するか。
// 出現しなければ「他箇所が古い綴り or 言及無し」の可能性が高い。
// builtins と ir-nodes を対象にする。
export const rule: Rule = {
    id: "R1-name-spelling",
    description: "カタログ内の命令名/ノード type が referenced_in の各 Markdown 箇所に実在し綴りが一致する",
    run(catalog: Catalog, docs: SpecDocs): Violation[] {
        const violations: Violation[] = [];

        // --- builtins ---
        for (const b of catalog.builtins) {
            const refs = b.referenced_in ?? [];
            for (const ref of refs) {
                const parsed = parseSpecRef(ref);
                if (!parsed) continue;
                const doc = docs.get(parsed.file);
                if (!doc) continue;
                const heading = resolveAnchor(doc, parsed.anchor);
                if (!heading) continue;
                const body = sectionText(doc, heading);
                if (!body.includes(b.name)) {
                    violations.push({
                        ruleId: rule.id,
                        severity: "error",
                        message: `命令 ${b.name} (${b.id}) が referenced_in に指定された ${ref} の本文に出現しない`,
                        location: { catalog: b.id, spec: ref, line: heading.line },
                        expected: b.name,
                        actual: "<not found in section>",
                    });
                }
            }
        }

        // --- ir-nodes ---
        for (const n of catalog.irNodes) {
            const refs = n.referenced_in ?? [];
            for (const ref of refs) {
                const parsed = parseSpecRef(ref);
                if (!parsed) continue;
                const doc = docs.get(parsed.file);
                if (!doc) continue;
                const heading = resolveAnchor(doc, parsed.anchor);
                if (!heading) continue;
                const body = sectionText(doc, heading);
                if (!body.includes(n.type)) {
                    violations.push({
                        ruleId: rule.id,
                        severity: "error",
                        message: `IR ノード ${n.type} (${n.id}) が referenced_in に指定された ${ref} の本文に出現しない`,
                        location: { catalog: n.id, spec: ref, line: heading.line },
                        expected: n.type,
                        actual: "<not found in section>",
                    });
                }
            }
        }

        return violations;
    },
};
