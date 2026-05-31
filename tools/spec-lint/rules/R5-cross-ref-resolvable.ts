import { Catalog, Rule, SpecDocs, Violation } from "../types";
import { parseSpecRef, resolveAnchor } from "../loader";

// R5: クロス参照の解決可能性。
// (a) YAML カタログの defined_in / referenced_in が実在見出しを指す。
// (b) Markdown 内の [テキスト](filename.md#anchor) 形式リンクが実在ファイル + 見出しを指す。
export const rule: Rule = {
    id: "R5-cross-ref-resolvable",
    description: "YAML 内の defined_in/referenced_in および Markdown 内クロスリンクが実在見出しを指す",
    run(catalog: Catalog, docs: SpecDocs): Violation[] {
        const violations: Violation[] = [];

        const checkRef = (ref: string, catalogId: string | undefined, source: string) => {
            const parsed = parseSpecRef(ref);
            if (!parsed) {
                violations.push({
                    ruleId: rule.id,
                    severity: "error",
                    message: `${source}: 参照形式が不正 (期待 "<file>#<anchor>"): ${ref}`,
                    location: { catalog: catalogId, spec: ref },
                });
                return;
            }
            const doc = docs.get(parsed.file);
            if (!doc) {
                violations.push({
                    ruleId: rule.id,
                    severity: "error",
                    message: `${source}: 参照先 Markdown ファイル ${parsed.file} が存在しない`,
                    location: { catalog: catalogId, spec: ref },
                });
                return;
            }
            // anchor が純粋な数字 (行番号) なら検証スキップ
            if (/^\d+$/.test(parsed.anchor)) return;
            const heading = resolveAnchor(doc, parsed.anchor);
            if (!heading) {
                violations.push({
                    ruleId: rule.id,
                    severity: "error",
                    message: `${source}: 参照 ${ref} が ${parsed.file} 内の見出しを解決できない`,
                    location: { catalog: catalogId, spec: ref },
                    expected: `${parsed.file} に '${parsed.anchor}' という節番号 or 見出しが存在`,
                    actual: "<not found>",
                });
            }
        };

        // (a) YAML カタログのクロス参照
        for (const b of catalog.builtins) {
            checkRef(b.defined_in, b.id, `builtins[${b.id}].defined_in`);
            for (const r of b.referenced_in ?? []) checkRef(r, b.id, `builtins[${b.id}].referenced_in`);
        }
        for (const n of catalog.irNodes) {
            checkRef(n.defined_in, n.id, `ir-nodes[${n.id}].defined_in`);
            for (const r of n.referenced_in ?? []) checkRef(r, n.id, `ir-nodes[${n.id}].referenced_in`);
        }
        for (const c of catalog.corelib) {
            checkRef(c.defined_in, c.id, `corelib[${c.id}].defined_in`);
            for (const r of c.referenced_in ?? []) checkRef(r, c.id, `corelib[${c.id}].referenced_in`);
        }

        // (b) Markdown 内の [text](file.md#anchor) リンク。同一仕様書群内でのみ検査する。
        const linkRe = /\[[^\]]*\]\((mozaicScript-[A-Za-z0-9_-]+-spec\.md)(?:#([^)]+))?\)/g;
        for (const [file, doc] of docs) {
            let m: RegExpExecArray | null;
            while ((m = linkRe.exec(doc.text)) !== null) {
                const targetFile = m[1];
                const anchor = m[2];
                const targetDoc = docs.get(targetFile);
                if (!targetDoc) {
                    violations.push({
                        ruleId: rule.id,
                        severity: "error",
                        message: `${file}: クロスリンク先 Markdown ${targetFile} が存在しない`,
                        location: { spec: `${file}#${targetFile}` },
                    });
                    continue;
                }
                if (!anchor) continue;
                // anchor は GitHub 流の slug 形式の可能性が高い (e.g. "1-凡例-および-適合性")
                // 単純な見出しテキスト一致を試みるが、解決できなくても warning 程度に留める
                const heading = resolveAnchor(targetDoc, anchor);
                if (!heading) {
                    violations.push({
                        ruleId: rule.id,
                        severity: "warning",
                        message: `${file}: クロスリンク ${targetFile}#${anchor} のアンカーが見出しに解決できない (GitHub slug の可能性)`,
                        location: { spec: `${file}#${anchor}` },
                        expected: `${targetFile} 内の見出しを指す`,
                        actual: anchor,
                    });
                }
            }
        }

        return violations;
    },
};
