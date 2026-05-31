import { Catalog, Rule, SpecDocs, Violation } from "../types";

// R4: アドレス単位の語彙が全 Markdown で一貫しているか。
// 既知矛盾 M2 は 2026-05-31 に「byte に統一」で解決済み。
// 本ルールは regression 検査として「word 系の語彙」が再導入されたらエラーを上げる。
// byte 系語彙は出現してよい (= 正本)。

// 2026-05-31: M2 解決 (byte に統一)。「ワードアドレス」「word インデックス」等が
// 仕様 Markdown に現れたらエラー。
const WORD_TERMS: RegExp[] = [
    /ワードアドレス/,
    /word\s*インデックス/,
    /word\s*アドレス/i,
    /2\s*word\s*分のアライメント/,
];

// 例外: 注記文中で「word ではない」「word を使わず」「M2 解決」のような
// 否定/解説形は許容する（リンタ自身のソースが含まれるテキストなど）。
const NEGATION_HINTS: RegExp[] = [
    /word\s*(を|は)\s*(使わず|無効|採用しない|使用しない|採らない)/,
    /(M2\s*解決|byte\s*に統一)/,
];

interface Hit {
    file: string;
    line: number;
    text: string;
    matchedBy: RegExp;
}

export const rule: Rule = {
    id: "R4-address-unit-lexicon",
    description:
        "アドレス単位の語彙が byte で統一されているか (M2 解決後の regression 検査)",
    run(_catalog: Catalog, docs: SpecDocs): Violation[] {
        const violations: Violation[] = [];
        const hits: Hit[] = [];

        for (const [file, doc] of docs) {
            for (let i = 0; i < doc.lines.length; i++) {
                const line = doc.lines[i];
                if (NEGATION_HINTS.some((re) => re.test(line))) continue;
                for (const regex of WORD_TERMS) {
                    if (regex.test(line)) {
                        hits.push({
                            file,
                            line: i + 1,
                            text: line.trim(),
                            matchedBy: regex,
                        });
                    }
                }
            }
        }

        for (const h of hits) {
            violations.push({
                ruleId: rule.id,
                severity: "error",
                message: `M2 regression: word 系アドレス語彙が ${h.file}:${h.line} に再導入されている (byte に統一済み)`,
                location: { spec: `${h.file}#${h.line}`, line: h.line },
                expected: "byte 系語彙のみ",
                actual: `${h.file}:${h.line}: ${h.text}`,
            });
        }

        return violations;
    },
};
