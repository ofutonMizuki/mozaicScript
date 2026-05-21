// compiler/index.ts — mozaicScript コンパイラ CLI
// 使用法: ts-node compiler/index.ts <entry.moz>
//
// エントリーファイルとその全依存ファイルを解析・型チェックして
// 各ファイルの <filename>.ast.json を生成する

import * as fs from 'fs';
import * as path from 'path';
import { lex, LexError } from './lexer';
import { parse, ParseError } from './parser';
import { Checker, CheckError, emptyRegistry } from './checker';
import { MozaicScriptAST } from '../interpreter/types';

const args = process.argv.slice(2);
if (args.length === 0) {
    console.error('Usage: ts-node compiler/index.ts <entry.moz>');
    process.exit(1);
}

const entryPath = path.resolve(args[0]);

// ── インポートグラフ解決 ──────────────────────────────────────────────────────

// (filePath, namespace | null) の順序付きリスト（トポロジカル順）
const order: { filePath: string; namespace: string | null }[] = [];
const visited  = new Set<string>();
const loading  = new Set<string>();

function collectDeps(filePath: string, namespace: string | null): void {
    if (visited.has(filePath)) return;
    if (loading.has(filePath)) {
        throw new Error(`循環インポートを検出: ${filePath}`);
    }
    loading.add(filePath);

    const src = readSource(filePath);
    const tokens = lex(src, filePath);
    const pfile = parse(tokens, filePath);

    // import 宣言を先に再帰処理
    for (const decl of pfile.decls) {
        if (decl.kind !== 'import') break; // import はファイル先頭のみ
        const importPath = path.resolve(path.dirname(filePath), decl.path);
        collectDeps(importPath, decl.namespace);
    }

    visited.add(filePath);
    loading.delete(filePath);
    order.push({ filePath, namespace });
}

function readSource(filePath: string): string {
    if (!fs.existsSync(filePath)) {
        throw new Error(`ファイルが見つかりません: ${filePath}`);
    }
    return fs.readFileSync(filePath, 'utf-8');
}

// ── メイン処理 ────────────────────────────────────────────────────────────────

try {
    collectDeps(entryPath, null);
} catch (e) {
    if (e instanceof LexError || e instanceof ParseError) {
        console.error(e.message);
        process.exit(1);
    }
    throw e;
}

const registry = emptyRegistry();
let hasError = false;

for (const { filePath } of order) {
    try {
        const src = readSource(filePath);
        const tokens = lex(src, filePath);
        const pfile  = parse(tokens, filePath);
        const checker = new Checker(registry);
        const nodes  = checker.check(pfile);

        const ast: MozaicScriptAST = { mozaicScript: '0.2.3', nodes };
        const outPath = filePath + '.ast.json';
        fs.writeFileSync(outPath, JSON.stringify(ast, null, 2), 'utf-8');
        console.log(`  ✓  ${path.relative(process.cwd(), outPath)}`);
    } catch (e) {
        if (e instanceof LexError || e instanceof ParseError || e instanceof CheckError) {
            console.error(e.message);
            hasError = true;
        } else {
            throw e;
        }
    }
}

if (hasError) process.exit(1);
