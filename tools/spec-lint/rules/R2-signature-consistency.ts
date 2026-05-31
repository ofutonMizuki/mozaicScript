import { BuiltinEntry, Catalog, Rule, SpecDocs, Violation } from "../types";
import { parseSpecRef, resolveAnchor, sectionText } from "../loader";

// R2: 同一命令が複数箇所に書かれている場合、引数数・型・戻り型が一致する。
// 仕様 Markdown 内に書かれた `name(arg: type, ...): returnType` 形式の最初の出現を抜き出して
// YAML との一致を見る。
//
// 厳密な YAML→Markdown 比較が困難な場合に備え、検出失敗時は警告に留める。
// 主目的は M1 — 「同名でも 32/64 や fence の有無が文書ごとに違う」を検出すること。

const SIG_REGEX_BY_NAME = (name: string): RegExp => {
    // Markdown 表内: `name(a: T, b: T): R` の形式。バックティック有無不問。
    // `*` 等のアスタリスク混入も許可。
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("`?\\b" + escaped + "\\(([^)]*)\\)\\s*(?::\\s*([A-Za-z0-9_<>,\\s]+))?", "g");
};

interface ParsedSig {
    paramCount: number;
    paramTypes: string[];
    returns: string | null;
}

function parseSignature(sig: string, name: string): ParsedSig | null {
    const re = SIG_REGEX_BY_NAME(name);
    const m = re.exec(sig);
    if (!m) return null;
    const paramsText = m[1].trim();
    const params = paramsText.length === 0
        ? []
        : paramsText.split(",").map((p) => p.trim());
    // 「name: type」形式以外は型注釈無しとして null を入れる。
    // IR §3-並行プリミティブ のような (id, pool) 形式 (型注釈なし) の場合に
    // 全引数型を null として落とし、型比較自体をスキップする。
    const paramTypes = params.map((p) => {
        const colon = p.indexOf(":");
        return colon >= 0 ? p.slice(colon + 1).trim() : "";
    });
    const returns = m[2] ? m[2].trim() : null;
    return { paramCount: params.length, paramTypes, returns };
}

function normalizeType(t: string): string {
    return t.replace(/\s+/g, "").replace(/`/g, "");
}

export const rule: Rule = {
    id: "R2-signature-consistency",
    description: "同一命令の引数数・型・戻り型が、定義 (defined_in) と参照箇所 (referenced_in) で一致する",
    run(catalog: Catalog, docs: SpecDocs): Violation[] {
        const violations: Violation[] = [];

        for (const b of catalog.builtins) {
            const allRefs = [b.defined_in, ...(b.referenced_in ?? [])];
            for (const ref of allRefs) {
                const parsed = parseSpecRef(ref);
                if (!parsed) continue;
                const doc = docs.get(parsed.file);
                if (!doc) continue;
                const heading = resolveAnchor(doc, parsed.anchor);
                if (!heading) continue;
                const body = sectionText(doc, heading);
                if (!body.includes(b.name)) continue; // R1 が拾う
                const sig = parseSignature(body, b.name);
                if (!sig) continue; // 表形式以外で言及されている場合は検査スキップ
                // 引数数の比較
                if (sig.paramCount !== b.params.length) {
                    violations.push({
                        ruleId: rule.id,
                        severity: "error",
                        message: `命令 ${b.name} (${b.id}) の引数数が ${ref} で不一致`,
                        location: { catalog: b.id, spec: ref, line: heading.line },
                        expected: `${b.params.length}`,
                        actual: `${sig.paramCount}`,
                    });
                    continue;
                }
                // 引数型の比較。"" は spec の表記が型注釈なし shorthand のためスキップ。
                for (let i = 0; i < sig.paramCount; i++) {
                    const actualRaw = sig.paramTypes[i];
                    if (actualRaw === "") continue; // shorthand: 型注釈なし
                    const expected = normalizeType(b.params[i].type);
                    const actual = normalizeType(actualRaw);
                    if (expected !== actual) {
                        violations.push({
                            ruleId: rule.id,
                            severity: "warning",
                            message: `命令 ${b.name} (${b.id}) の引数#${i} (${b.params[i].name}) の型が ${ref} で不一致`,
                            location: { catalog: b.id, spec: ref, line: heading.line },
                            expected,
                            actual,
                        });
                    }
                }
                // 戻り型の比較
                if (sig.returns !== null) {
                    const expected = normalizeType(b.returns);
                    const actual = normalizeType(sig.returns);
                    if (expected !== actual) {
                        violations.push({
                            ruleId: rule.id,
                            severity: "warning",
                            message: `命令 ${b.name} (${b.id}) の戻り型が ${ref} で不一致`,
                            location: { catalog: b.id, spec: ref, line: heading.line },
                            expected,
                            actual,
                        });
                    }
                }
            }
        }

        // ── M1 補助検出: engine 仕様にも命令が「実装登録」として出ているか ──
        // 「__builtin_atomic_load」など 32/64 のサフィックスがない綴りが engine spec に
        // 登録されていれば、catalog 側の正式名 (load32/64) と一致しないことを通知する。
        // 検出は単純な文字列スキャン: engine-spec 全体で `__builtin_atomic_load` の後に
        // 数字が続かない箇所を探す。
        const engineDoc = docs.get("mozaicScript-engine-spec.md");
        if (engineDoc) {
            const text = engineDoc.text;
            // catalog 内のアトミック命令名
            const atomicNames = catalog.builtins
                .filter((b) => b.group === "concurrency.atomic")
                .map((b) => b.name);
            // catalog にある正式名は全部捨てて、残った "__builtin_atomic_*" を違反として報告
            const re = /__builtin_atomic_[A-Za-z0-9_]+/g;
            const found = new Set<string>();
            let m: RegExpExecArray | null;
            while ((m = re.exec(text)) !== null) found.add(m[0]);
            for (const name of found) {
                if (atomicNames.includes(name)) continue;
                // catalog にない == 仕様カタログと engine 実装が不一致 (M1/E1)
                const lineIdx = engineDoc.lines.findIndex((l) => l.includes(name));
                violations.push({
                    ruleId: rule.id,
                    severity: "error",
                    message: `エンジン仕様に登録されている ${name} が命令カタログに存在しない（M1/E1: 32/64 サフィックスや fence の不整合）`,
                    location: {
                        spec: `mozaicScript-engine-spec.md#${lineIdx >= 0 ? lineIdx + 1 : "?"}`,
                        line: lineIdx >= 0 ? lineIdx + 1 : undefined,
                    },
                    expected: "命令カタログのいずれかと一致",
                    actual: name,
                });
            }
        }

        return violations;
    },
};
