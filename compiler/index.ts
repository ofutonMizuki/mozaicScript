// compiler/index.ts — mozaicScript コンパイラ CLI
// 使用法: ts-node compiler/index.ts [-O0|-O1|-O2] <entry.moz>
//
// オプション:
//   -O0  最適化なし（デバッグ用。チェッカー出力の IR をそのまま出力）
//   -O1  メソッドインライン展開のみ
//   -O2  全最適化（デフォルト。定数畳み込み・代数的恒等式を含む）
//
// エントリーファイルとその全依存ファイルを解析・型チェックして
// 各ファイルの <filename>.ast.json を生成する

import * as fs from 'fs';
import * as path from 'path';
import { lex, LexError } from './lexer';
import { parse, ParseError } from './parser';
import { Checker, CheckError, emptyRegistry } from './checker';
import { BorrowChecker, BorrowError } from './borrowcheck';
import { Optimizer, OptLevel } from './optimizer';
import { lowerModule as lowerGpuModule } from './gpulower';
import { MozaicScriptAST } from '../interpreter/types';

const rawArgs = process.argv.slice(2);

// ── オプション解析 ────────────────────────────────────────────────────────────

let optLevel: OptLevel = 2; // デフォルト -O2
const fileArgs: string[] = [];

for (const arg of rawArgs) {
    if      (arg === '-O0') optLevel = 0;
    else if (arg === '-O1') optLevel = 1;
    else if (arg === '-O2') optLevel = 2;
    else                    fileArgs.push(arg);
}

if (fileArgs.length === 0) {
    console.error('Usage: ts-node compiler/index.ts [-O0|-O1|-O2] <entry.moz>');
    process.exit(1);
}

const entryPath = path.resolve(fileArgs[0]);

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
} catch (e: unknown) {
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

        // 借用チェック & drop/__builtin_free 自動挿入 (Phase 3)
        const borrowChecker = new BorrowChecker(registry);
        borrowChecker.check(nodes);

        const optimizer = new Optimizer(registry, optLevel);
        const optimized = optimizer.optimize(nodes);

        const ast: MozaicScriptAST = { mozaicScript: '0.2.3', nodes: optimized };
        const outPath = filePath + '.ast.json';
        fs.writeFileSync(outPath, JSON.stringify(ast, null, 2), 'utf-8');
        const optTag = optLevel === 2 ? '' : ` [-O${optLevel}]`;
        console.log(`  ✓  ${path.relative(process.cwd(), outPath)}${optTag}`);

        // §14 / GPU IR 仕様: 当該ファイルに gpu 関数があれば .gpu.json を出力
        // (チェッカー後 / 借用チェック後 / 最適化後の IR をそのまま lower する)
        const gpuMod = lowerGpuModule(optimized);
        if (gpuMod) {
            // <filename>.moz.ast.json と並べて <filename>.moz.gpu.json
            const gpuOut = filePath + '.gpu.json';
            fs.writeFileSync(gpuOut, JSON.stringify(gpuMod, null, 2), 'utf-8');
            console.log(`  ✓  ${path.relative(process.cwd(), gpuOut)}`);
        }
    } catch (e) {
        if (e instanceof LexError || e instanceof ParseError || e instanceof CheckError || e instanceof BorrowError) {
            console.error(`${filePath}: ${e.message}`);
            hasError = true;
        } else {
            throw e;
        }
    }
}

if (hasError) process.exit(1);
