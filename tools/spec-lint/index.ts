import * as fs from "fs";
import * as path from "path";
import { loadCatalog, loadSpecDocs } from "./loader";
import { LintReport, Rule, Violation } from "./types";

import { rule as R1 } from "./rules/R1-name-spelling";
import { rule as R2 } from "./rules/R2-signature-consistency";
import { rule as R3 } from "./rules/R3-ir-node-coverage";
import { rule as R4 } from "./rules/R4-address-unit-lexicon";
import { rule as R5 } from "./rules/R5-cross-ref-resolvable";
import { rule as R6 } from "./rules/R6-lowers-to-resolvable";
import { rule as R7 } from "./rules/R7-return-semantics";
import { rule as R8 } from "./rules/R8-design-decisions";

const ALL_RULES: Rule[] = [R1, R2, R3, R4, R5, R6, R7, R8];

function emitReport(report: LintReport, reportPath: string): void {
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
}

function printHuman(report: LintReport): void {
    const v = report.violations;
    const s = report.summary;
    console.log(`\n=== mozaicScript spec-lint report ===`);
    console.log(`total: ${s.total}  errors: ${s.errors}  warnings: ${s.warnings}  design-decisions: ${s.designDecisions}`);
    console.log(`per rule: ${Object.entries(s.byRule).map(([k, n]) => `${k}=${n}`).join(", ")}\n`);

    for (const viol of v) {
        const sev = viol.severity.padEnd(16);
        const loc = viol.location.spec
            ? ` @ ${viol.location.spec}`
            : viol.location.catalog
            ? ` @ catalog:${viol.location.catalog}`
            : "";
        console.log(`[${sev}] ${viol.ruleId}${loc}`);
        console.log(`         ${viol.message}`);
        if (viol.expected !== undefined) {
            console.log(`         expected: ${viol.expected}`);
            console.log(`         actual  : ${viol.actual}`);
        }
    }
}

function summarize(violations: Violation[]): LintReport["summary"] {
    const byRule: Record<string, number> = {};
    let errors = 0;
    let warnings = 0;
    let designDecisions = 0;
    for (const v of violations) {
        byRule[v.ruleId] = (byRule[v.ruleId] ?? 0) + 1;
        if (v.severity === "error") errors++;
        else if (v.severity === "warning") warnings++;
        else if (v.severity === "design-decision") designDecisions++;
    }
    return {
        total: violations.length,
        errors,
        warnings,
        designDecisions,
        byRule,
    };
}

function main(): void {
    const catalog = loadCatalog();
    const docs = loadSpecDocs();
    const allViolations: Violation[] = [];

    // ルール選択フィルタ: --rules R1,R3 のような形で指定可能
    const args = process.argv.slice(2);
    let selected: Set<string> | null = null;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--rules" && i + 1 < args.length) {
            selected = new Set(args[i + 1].split(",").map((s) => s.trim()));
        }
    }

    for (const rule of ALL_RULES) {
        if (selected && ![...selected].some((s) => rule.id.startsWith(s))) continue;
        try {
            const v = rule.run(catalog, docs);
            allViolations.push(...v);
        } catch (e) {
            allViolations.push({
                ruleId: rule.id,
                severity: "error",
                message: `ルール ${rule.id} 実行時に例外: ${(e as Error).message}`,
                location: {},
            });
        }
    }

    const report: LintReport = {
        summary: summarize(allViolations),
        violations: allViolations,
    };

    const reportPath = path.join(__dirname, "report.json");
    emitReport(report, reportPath);
    printHuman(report);

    if (report.summary.errors > 0) {
        process.exit(1);
    }
}

main();
