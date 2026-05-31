import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import {
    BuiltinEntry,
    Catalog,
    CorelibEntry,
    Heading,
    IrNodeEntry,
    SpecDoc,
    SpecDocs,
} from "./types";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CATALOG_ROOT = path.join(REPO_ROOT, "spec", "catalog");
const DOC_ROOT = path.join(REPO_ROOT, "doc");

const SPEC_FILES = [
    "mozaicScript-spec.md",
    "mozaicScript-corelib-spec.md",
    "mozaicScript-ir-spec.md",
    "mozaicScript-engine-spec.md",
];

function loadYamlList<T>(dir: string): T[] {
    if (!fs.existsSync(dir)) return [];
    const entries: T[] = [];
    for (const file of fs.readdirSync(dir).sort()) {
        if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
        const fullPath = path.join(dir, file);
        const text = fs.readFileSync(fullPath, "utf-8");
        const parsed = yaml.load(text);
        if (!Array.isArray(parsed)) {
            throw new Error(`YAML file ${fullPath} must contain a top-level array`);
        }
        for (const e of parsed) entries.push(e as T);
    }
    return entries;
}

export function loadCatalog(): Catalog {
    return {
        builtins: loadYamlList<BuiltinEntry>(path.join(CATALOG_ROOT, "builtins")),
        irNodes: loadYamlList<IrNodeEntry>(path.join(CATALOG_ROOT, "ir-nodes")),
        corelib: loadYamlList<CorelibEntry>(path.join(CATALOG_ROOT, "corelib")),
    };
}

// 見出し行から先頭の "9.11" のような節番号を抜き出す。
// "## 9.11 マルチスレッド命令" → "9.11"
// "### 5.1 boolean" → "5.1"
// 抽出できなければ null。
function extractSectionNumber(text: string): string | null {
    const m = text.match(/^([0-9]+(?:\.[0-9]+)*)\s/);
    return m ? m[1] : null;
}

function parseHeadings(lines: string[]): Heading[] {
    const headings: Heading[] = [];
    let inCodeFence = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith("```")) {
            inCodeFence = !inCodeFence;
            continue;
        }
        if (inCodeFence) continue;
        const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
        if (!m) continue;
        const level = m[1].length;
        const text = m[2].trim();
        headings.push({
            level,
            text,
            line: i + 1,
            sectionNumber: extractSectionNumber(text),
        });
    }
    return headings;
}

export function loadSpecDocs(): SpecDocs {
    const docs: SpecDocs = new Map();
    for (const file of SPEC_FILES) {
        const fullPath = path.join(DOC_ROOT, file);
        if (!fs.existsSync(fullPath)) {
            throw new Error(`Spec file not found: ${fullPath}`);
        }
        const text = fs.readFileSync(fullPath, "utf-8");
        const lines = text.split(/\r?\n/);
        const headings = parseHeadings(lines);
        docs.set(file, { file, fullPath, text, lines, headings });
    }
    return docs;
}

/**
 * "mozaicScript-spec.md#9.11" のような参照を分解する。
 * 戻り値: { file, anchor }
 */
export function parseSpecRef(ref: string): { file: string; anchor: string } | null {
    const idx = ref.indexOf("#");
    if (idx < 0) return null;
    return { file: ref.slice(0, idx), anchor: ref.slice(idx + 1) };
}

/**
 * 指定の anchor (節番号 "9.11" もしくは見出しテキストの先頭一致) に
 * マッチする見出しを返す。見つからなければ null。
 */
export function resolveAnchor(doc: SpecDoc, anchor: string): Heading | null {
    // (1) 節番号で完全一致
    for (const h of doc.headings) {
        if (h.sectionNumber === anchor) return h;
    }
    // (2) 見出し本文の先頭一致 (節番号を除いた本文との一致もチェック)
    for (const h of doc.headings) {
        if (h.text === anchor) return h;
        if (h.text.startsWith(anchor + " ")) return h;
        if (h.text.startsWith(anchor)) return h;
        // 節番号を取り除いた本文
        const body = h.text.replace(/^[0-9]+(?:\.[0-9]+)*\s+/, "");
        if (body === anchor) return h;
        if (body.startsWith(anchor)) return h;
    }
    return null;
}

/**
 * heading が属するセクションの本文範囲 (line 番号、1-based) を返す。
 * 範囲は当該見出し直後から、同レベル以下の次の見出し直前まで。
 */
export function sectionBody(doc: SpecDoc, heading: Heading): { start: number; end: number } {
    const start = heading.line + 1;
    let end = doc.lines.length;
    for (const h of doc.headings) {
        if (h.line <= heading.line) continue;
        if (h.level <= heading.level) {
            end = h.line - 1;
            break;
        }
    }
    return { start, end };
}

export function sectionText(doc: SpecDoc, heading: Heading): string {
    const { start, end } = sectionBody(doc, heading);
    return doc.lines.slice(start - 1, end).join("\n");
}
