import { Catalog, Rule, SpecDocs, Violation } from "../types";
import { resolveAnchor, sectionText } from "../loader";

// R3: must_appear_in_ir_node_list: true のノードが、IR 仕様§3 (ノード一覧) に実在する。
// 既知矛盾 M3 (BorrowExpr が IR §3 一覧に未収録) を検出する。
export const rule: Rule = {
    id: "R3-ir-node-coverage",
    description: "must_appear_in_ir_node_list: true の IR ノードが IR 仕様§3 ノード一覧に実在する",
    run(catalog: Catalog, docs: SpecDocs): Violation[] {
        const violations: Violation[] = [];
        const irDoc = docs.get("mozaicScript-ir-spec.md");
        if (!irDoc) {
            violations.push({
                ruleId: rule.id,
                severity: "error",
                message: "IR 仕様書が見つからない",
                location: {},
            });
            return violations;
        }
        // §3 ノード一覧の見出しを探す
        const sec3 = resolveAnchor(irDoc, "3");
        if (!sec3) {
            violations.push({
                ruleId: rule.id,
                severity: "error",
                message: "IR 仕様§3 (ノード一覧) の見出しが見つからない",
                location: { spec: "mozaicScript-ir-spec.md#3" },
            });
            return violations;
        }
        const body = sectionText(irDoc, sec3);

        // engine 仕様の ASTNode union も検査対象に含める (E2 検出用)
        const engineDoc = docs.get("mozaicScript-engine-spec.md");
        let engineAstUnion: string | null = null;
        if (engineDoc) {
            // "export type ASTNode = ..." から ";" まで
            const text = engineDoc.text;
            const m = text.match(/export type ASTNode\s*=\s*([\s\S]*?);/);
            if (m) engineAstUnion = m[1];
        }

        for (const n of catalog.irNodes) {
            if (!n.must_appear_in_ir_node_list) continue;

            // IR §3 ノード一覧本文内に type 名が出現するか
            if (!body.includes(n.type)) {
                violations.push({
                    ruleId: rule.id,
                    severity: "error",
                    message: `IR ノード ${n.type} (${n.id}) が IR 仕様§3 のノード一覧に未収録 (M3 / E2)`,
                    location: {
                        catalog: n.id,
                        spec: "mozaicScript-ir-spec.md#3",
                        line: sec3.line,
                    },
                    expected: `'${n.type}' が IR 仕様§3 のノード一覧に出現`,
                    actual: "<not found>",
                });
            }

            // engine 仕様 ASTNode union に出現するか
            if (engineAstUnion !== null && !engineAstUnion.includes(n.type)) {
                violations.push({
                    ruleId: rule.id,
                    severity: "error",
                    message: `IR ノード ${n.type} (${n.id}) が engine 仕様 ASTNode union に未収録 (E2)`,
                    location: {
                        catalog: n.id,
                        spec: "mozaicScript-engine-spec.md#3",
                    },
                    expected: `ASTNode union に '${n.type}' が含まれる`,
                    actual: "<not found>",
                });
            }
        }

        // 追加: FunctionDecl.isMut フィールドが IR 仕様§5 FunctionDecl 例にあるか
        // YAML 上に isMut を required: true で記録しているので、IR §5 にもあるべき
        const fnDecl = catalog.irNodes.find((n) => n.type === "FunctionDecl");
        if (fnDecl) {
            const hasIsMut = fnDecl.fields.some((f) => f.name === "isMut");
            if (hasIsMut) {
                const sec5 = resolveAnchor(irDoc, "5");
                if (sec5) {
                    const body5 = sectionText(irDoc, sec5);
                    if (!body5.includes("isMut")) {
                        violations.push({
                            ruleId: rule.id,
                            severity: "error",
                            message: `FunctionDecl.isMut が IR 仕様§5 のノード定義に未収録 (M3)`,
                            location: {
                                catalog: fnDecl.id,
                                spec: "mozaicScript-ir-spec.md#5",
                                line: sec5.line,
                            },
                            expected: "'isMut' が FunctionDecl ノードの例 JSON に含まれる",
                            actual: "<not found>",
                        });
                    }
                }
                // engine 仕様 FunctionDecl interface にも isMut があるか
                if (engineDoc && !engineDoc.text.includes("isMut")) {
                    violations.push({
                        ruleId: rule.id,
                        severity: "error",
                        message: `FunctionDecl.isMut が engine 仕様 (types.ts FunctionDecl interface) に未収録 (E2)`,
                        location: {
                            catalog: fnDecl.id,
                            spec: "mozaicScript-engine-spec.md#3",
                        },
                        expected: "'isMut' が FunctionDecl interface に含まれる",
                        actual: "<not found>",
                    });
                }
            }
        }

        return violations;
    },
};
