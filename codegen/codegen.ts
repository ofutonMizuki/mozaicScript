// codegen/codegen.ts — mozaicScript IR → C コードジェネレータ

import * as fs from "fs";
import * as nodePath from "path";
import {
    ASTNode, ClassDecl, FunctionDecl, MozaicScriptAST,
} from "../interpreter/types";

// ── 型ユーティリティ ──────────────────────────────────────────────────────────

function baseType(mozType: string): string {
    const lt = mozType.indexOf("<");
    return lt === -1 ? mozType : mozType.slice(0, lt);
}

function typeArgs(mozType: string): string[] {
    const lt = mozType.indexOf("<");
    if (lt === -1) return [];
    const inner = mozType.slice(lt + 1, mozType.lastIndexOf(">"));
    const result: string[] = [];
    let depth = 0, start = 0;
    for (let i = 0; i < inner.length; i++) {
        if (inner[i] === "<") depth++;
        else if (inner[i] === ">") depth--;
        else if (inner[i] === "," && depth === 0) {
            result.push(inner.slice(start, i).trim());
            start = i + 1;
        }
    }
    const last = inner.slice(start).trim();
    if (last) result.push(last);
    return result;
}

function applySubst(mozType: string, subst: Map<string, string>): string {
    const direct = subst.get(mozType);
    if (direct !== undefined) return direct;
    const base = baseType(mozType);
    const args = typeArgs(mozType);
    if (args.length === 0) return mozType;
    return `${base}<${args.map(a => applySubst(a, subst)).join(",")}>`;
}

// ── 演算子名マングル ──────────────────────────────────────────────────────────

const OPERATOR_MAP: Record<string, string> = {
    "operator+":        "op_add",
    "operator-":        "op_sub",
    "operator*":        "op_mul",
    "operator/":        "op_div",
    "operator%":        "op_mod",
    "operator==":       "op_eq",
    "operator<":        "op_lt",
    "operator>":        "op_gt",
    "operator||":       "op_or",
    "operator&&":       "op_and",
    "operatorNot":      "op_not",
    "operatorNeg":      "op_neg",
    "operator[]":       "op_index_get",
    "operator_set[]":   "op_index_set",
    "constructor":      "constructor",
};

function mangleMethod(method: string): string {
    return OPERATOR_MAP[method] ?? method;
}

// ── C名前生成 ──────────────────────────────────────────────────────────────────

function cStructName(mozType: string): string {
    if (mozType === "_m32" || mozType === "_m64" || mozType === "_m128") return "int32_t";
    if (mozType === "void") return "void";
    const base = baseType(mozType);
    const args = typeArgs(mozType);
    if (args.length === 0) return `_ms_${base}`;
    return `_ms_${base}_${args.map(a => cStructName(a).replace(/^_ms_/, "")).join("_")}`;
}

function cMethodName(classType: string, method: string): string {
    return `${cStructName(classType)}__${mangleMethod(method)}`;
}

// ── CCodegen ──────────────────────────────────────────────────────────────────

export class CCodegen {
    private classes      = new Map<string, ClassDecl>();
    private functions    = new Map<string, FunctionDecl>();
    private typeAliases  = new Map<string, string>();
    private genericInsts = new Set<string>();
    private loadedFiles  = new Set<string>();
    private tmpCount     = 0;

    // シンボルの出所追跡（シンボル名 → 絶対ファイルパス）
    private classOrigin  = new Map<string, string>();
    private fnOrigin     = new Map<string, string>();
    // エントリファイル情報
    private entryFile    = "";
    // エントリが直接 import しているファイル（順序保持）
    private entryImports: { absPath: string; cName: string }[] = [];

    constructor(_baseDir: string) {}

    // ── AST 読み込み ──────────────────────────────────────────────────────────

    loadAST(filePath: string): void {
        // 最初の呼び出しがエントリファイル
        if (!this.entryFile) this.entryFile = filePath;

        if (this.loadedFiles.has(filePath)) return;
        this.loadedFiles.add(filePath);

        const astPath = filePath + ".ast.json";
        const ast: MozaicScriptAST = JSON.parse(fs.readFileSync(astPath, "utf-8"));

        // 依存を先に処理
        for (const node of ast.nodes) {
            if (node.type === "ImportDecl") {
                const dep = nodePath.resolve(nodePath.dirname(filePath), node.path);
                // エントリファイルの直接インポートを記録
                if (filePath === this.entryFile) {
                    const cName = nodePath.basename(dep).replace(/\.(moz|moc)$/, ".c");
                    this.entryImports.push({ absPath: dep, cName });
                }
                this.loadAST(dep);
            }
        }

        for (const node of ast.nodes) {
            if (node.type === "ClassDecl") {
                this.classes.set(node.name, node);
                this.classOrigin.set(node.name, filePath);
            } else if (node.type === "FunctionDecl") {
                this.functions.set(node.name, node);
                this.fnOrigin.set(node.name, filePath);
            } else if (node.type === "TypeAliasDecl") {
                this.typeAliases.set(node.name, node.resolvedType);
            }
        }

        this.scanGenericInsts(ast.nodes);
    }

    // ── ジェネリック収集 ──────────────────────────────────────────────────────

    private scanGenericInsts(nodes: ASTNode[]): void {
        for (const node of nodes) this.scanNode(node, new Set());
    }

    private collectType(t: string, excluded: Set<string>): void {
        const base = baseType(t);
        if (excluded.has(base)) return; // 型パラメータ自身はスキップ
        const args = typeArgs(t);
        if (args.length > 0) {
            if (args.some(a => excluded.has(baseType(a)))) return; // 未解決パラメータを含む
            this.genericInsts.add(t);
            args.forEach(a => this.collectType(a, excluded));
        }
    }

    private scanNode(node: ASTNode, excluded: Set<string>): void {
        switch (node.type) {
            case "ClassDecl": {
                const ex = new Set([...excluded, ...node.typeParams]);
                node.members.forEach(m => this.collectType(m.resolvedType, ex));
                node.methods.forEach(m => this.scanFn(m, new Map(), ex));
                break;
            }
            case "FunctionDecl":
                this.scanFn(node, new Map(), excluded);
                break;
            case "VarDecl":
                this.collectType(node.resolvedType, excluded);
                this.scanNode(node.value, excluded);
                break;
            case "MethodCall":
                this.collectType(node.resolvedType, excluded);
                this.collectType((node.receiver as any).resolvedType ?? "", excluded);
                this.scanNode(node.receiver, excluded);
                node.args.forEach(a => this.scanNode(a, excluded));
                break;
            case "NewExpr":
                this.collectType(node.resolvedType, excluded);
                node.args.forEach(a => this.scanNode(a, excluded));
                break;
            case "Intrinsic":
                this.collectType(node.resolvedType, excluded);
                node.args.forEach(a => this.scanNode(a, excluded));
                break;
            case "MemberAccess":
                this.collectType(node.resolvedType, excluded);
                this.scanNode(node.receiver, excluded);
                break;
            case "Assign":
                this.scanNode(node.target, excluded);
                this.scanNode(node.value, excluded);
                break;
            case "IfStmt":
                this.scanNode(node.cond, excluded);
                node.body.forEach(n => this.scanNode(n, excluded));
                if (node.else) this.scanNode(node.else as unknown as ASTNode, excluded);
                break;
            case "ElseStmt":
                node.body.forEach(n => this.scanNode(n, excluded));
                break;
            case "WhileStmt":
                this.scanNode(node.cond, excluded);
                node.body.forEach(n => this.scanNode(n, excluded));
                break;
            case "ForStmt":
                this.scanNode(node.init, excluded);
                this.scanNode(node.cond, excluded);
                this.scanNode(node.update, excluded);
                node.body.forEach(n => this.scanNode(n, excluded));
                break;
            case "ReturnStmt":
                if (node.value) this.scanNode(node.value, excluded);
                break;
        }
    }

    private scanFn(fn: FunctionDecl, subst: Map<string, string>, excluded: Set<string>): void {
        fn.params.forEach(p => this.collectType(applySubst(p.resolvedType, subst), excluded));
        this.collectType(applySubst(fn.returnType, subst), excluded);
        fn.body.forEach(n => this.scanNode(n, excluded));
    }

    // ── エミット ──────────────────────────────────────────────────────────────

    emit(): string {
        const hasImports = this.entryImports.length > 0;
        const parts: string[] = [];

        if (hasImports) {
            // インポートを #include に変換（プリアンブルはインクルード先が持つ）
            parts.push(this.emitIncludes());
        } else {
            // スタンドアロン: プリアンブルをここに出力
            parts.push(this.emitPreamble());
        }

        parts.push(this.emitStructDefs(hasImports));
        parts.push(this.emitFunctionProtos());
        parts.push(this.emitAllFunctions());
        parts.push(this.emitMain());
        return parts.filter(p => p.trim()).join("\n\n");
    }

    private emitIncludes(): string {
        return this.entryImports.map(imp => `#include "${imp.cName}"`).join("\n");
    }

    // エントリファイル固有のシンボルか判定
    private isOwn(filePath: string): boolean {
        return filePath === this.entryFile;
    }

    // ── プリアンブル ──────────────────────────────────────────────────────────

    private emitPreamble(): string {
        return `\
/* generated by mozaicScript codegen */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <math.h>

/* ── Heap (word-addressed flat memory) ── */
#define _MS_HEAP_WORDS (1 << 18)
static int32_t _ms_heap[_MS_HEAP_WORDS];
static int32_t _ms_heap_next = 1; /* 0 = null */

static int32_t _ms_malloc(int32_t size_bytes) {
    int32_t addr = _ms_heap_next;
    _ms_heap_next += (size_bytes + 3) / 4;
    return addr;
}
static void _ms_free(int32_t addr) { (void)addr; }
static int32_t _ms_mem_read32(int32_t ptr, int32_t byte_offset) {
    return _ms_heap[(int32_t)(ptr) + (int32_t)(byte_offset) / 4];
}
static void _ms_mem_write32(int32_t ptr, int32_t byte_offset, int32_t value) {
    _ms_heap[(int32_t)(ptr) + (int32_t)(byte_offset) / 4] = value;
}

/* ── f32 bit conversion ── */
static inline int32_t _ms_f32_bits(float f) {
    int32_t r; memcpy(&r, &f, 4); return r;
}
static inline float _ms_bits_f32(int32_t b) {
    float r; memcpy(&r, &b, 4); return r;
}

/* ── I/O helpers (defined after structs — forward declare here) ── */
static void _ms_write_str(int32_t ptr, int32_t len);
static void _ms_write_str_err(int32_t ptr, int32_t len);
static void _ms_panic_str(int32_t ptr, int32_t len);
`;
    }

    // ── 構造体定義 ────────────────────────────────────────────────────────────

    // hasImports=true のとき、インポート済みシンボルはスキップする
    private emitStructDefs(hasImports: boolean): string {
        const lines: string[] = ["/* ── Struct definitions ── */"];
        let emittedAny = false;

        const ordered = this.topoSortClasses();

        for (const concreteType of ordered) {
            const base   = baseType(concreteType);
            const args   = typeArgs(concreteType);
            const cls    = this.classes.get(base);
            if (!cls) continue;

            // インポートがある場合、他ファイル由来の型はスキップ
            if (hasImports && !this.isOwn(this.classOrigin.get(base) ?? "")) continue;

            const subst = new Map<string, string>();
            cls.typeParams.forEach((p, i) => subst.set(p, args[i] ?? p));

            const sname = cStructName(concreteType);
            lines.push(`typedef struct {`);
            for (const field of cls.members) {
                const ftype = cStructName(applySubst(field.resolvedType, subst));
                lines.push(`    ${ftype} ${field.name};`);
            }
            lines.push(`} ${sname};`);
            emittedAny = true;
        }

        // I/Oヘルパー実装はスタンドアロン時（インポートなし）のみ出力
        if (!hasImports) {
            lines.push(`
static void _ms_write_str(int32_t ptr, int32_t len) {
    for (int32_t i = 0; i < len; i++) {
        uint32_t ch = (uint32_t)_ms_heap[ptr + i];
        if (ch < 0x80) { putchar((char)ch); }
        else if (ch < 0x800) { putchar((char)(0xC0|(ch>>6))); putchar((char)(0x80|(ch&0x3F))); }
        else { putchar((char)(0xE0|(ch>>12))); putchar((char)(0x80|((ch>>6)&0x3F))); putchar((char)(0x80|(ch&0x3F))); }
    }
}
static void _ms_write_str_err(int32_t ptr, int32_t len) {
    for (int32_t i = 0; i < len; i++) {
        uint32_t ch = (uint32_t)_ms_heap[ptr + i];
        if (ch < 128) fputc((char)ch, stderr);
    }
}
static void _ms_panic_str(int32_t ptr, int32_t len) {
    fprintf(stderr, "[PANIC] ");
    _ms_write_str_err(ptr, len);
    fputc('\\n', stderr);
    exit(1);
}`);
            emittedAny = true;
        }

        return emittedAny ? lines.join("\n") : "";
    }

    // トポロジカルソート（依存する型を先に出す）
    private topoSortClasses(): string[] {
        const allTypes: string[] = [];
        // 非ジェネリッククラス
        for (const [name, cls] of this.classes) {
            if (cls.typeParams.length === 0) allTypes.push(name);
        }
        // ジェネリックインスタンス
        for (const inst of this.genericInsts) allTypes.push(inst);

        const visited = new Set<string>();
        const result:  string[] = [];

        const visit = (t: string) => {
            if (visited.has(t)) return;
            visited.add(t);
            const base = baseType(t);
            const args = typeArgs(t);
            const cls  = this.classes.get(base);
            if (!cls) return;
            const subst = new Map<string, string>();
            cls.typeParams.forEach((p, i) => subst.set(p, args[i] ?? p));
            for (const field of cls.members) {
                const dep = applySubst(field.resolvedType, subst);
                if (dep !== "_m32" && dep !== "_m64" && dep !== "void") {
                    visit(dep);
                }
            }
            result.push(t);
        };

        for (const t of allTypes) visit(t);
        return result;
    }

    // ── 前方宣言 ──────────────────────────────────────────────────────────────

    private emitFunctionProtos(): string {
        const lines: string[] = ["/* ── Forward declarations ── */"];
        const hasImports = this.entryImports.length > 0;
        const ordered = this.topoSortClasses();

        for (const concreteType of ordered) {
            const base = baseType(concreteType);
            const args = typeArgs(concreteType);
            const cls  = this.classes.get(base);
            if (!cls) continue;
            // インポートがある場合、他ファイル由来のクラスはスキップ
            if (hasImports && !this.isOwn(this.classOrigin.get(base) ?? "")) continue;
            const subst = new Map<string, string>();
            cls.typeParams.forEach((p, i) => subst.set(p, args[i] ?? p));
            for (const method of cls.methods) {
                lines.push(this.methodSignature(concreteType, method, subst) + ";");
            }
        }

        for (const [name, fn] of this.functions) {
            // インポートがある場合、他ファイル由来の関数はスキップ
            if (hasImports && !this.isOwn(this.fnOrigin.get(name) ?? "")) continue;
            const params = fn.params.map(p => `${cStructName(p.resolvedType)} ${p.name}`);
            lines.push(`static ${cStructName(fn.returnType)} _ms_${name}(${params.join(", ")});`);
        }

        return lines.join("\n");
    }

    // ── 関数エミット ──────────────────────────────────────────────────────────

    private emitAllFunctions(): string {
        const lines: string[] = ["/* ── Functions ── */"];
        const hasImports = this.entryImports.length > 0;
        const ordered = this.topoSortClasses();

        for (const concreteType of ordered) {
            const base = baseType(concreteType);
            const args = typeArgs(concreteType);
            const cls  = this.classes.get(base);
            if (!cls) continue;
            // インポートがある場合、他ファイル由来のクラスはスキップ
            if (hasImports && !this.isOwn(this.classOrigin.get(base) ?? "")) continue;
            const subst = new Map<string, string>();
            cls.typeParams.forEach((p, i) => subst.set(p, args[i] ?? p));
            for (const method of cls.methods) {
                lines.push(this.emitMethod(concreteType, method, subst));
            }
        }

        for (const [name, fn] of this.functions) {
            // インポートがある場合、他ファイル由来の関数はスキップ
            if (hasImports && !this.isOwn(this.fnOrigin.get(name) ?? "")) continue;
            lines.push(this.emitFreeFunction(fn));
        }

        return lines.join("\n\n");
    }

    private methodSignature(classType: string, method: FunctionDecl, subst: Map<string, string>): string {
        const sname   = cStructName(classType);
        const fnName  = cMethodName(classType, method.name);
        const retType = cStructName(applySubst(method.returnType, subst));
        const params: string[] = [`${sname}* self`];
        for (const p of method.params) {
            params.push(`${cStructName(applySubst(p.resolvedType, subst))} ${p.name}`);
        }
        return `static ${retType} ${fnName}(${params.join(", ")})`;
    }

    private emitMethod(
        classType: string,
        method: FunctionDecl,
        subst: Map<string, string>,
    ): string {
        this.tmpCount = 0;
        const mozRetType = applySubst(method.returnType, subst);
        const bodyLines  = this.emitBody(method.body, "    ", subst, mozRetType);
        return `${this.methodSignature(classType, method, subst)} {\n${bodyLines}\n}`;
    }

    private emitFreeFunction(fn: FunctionDecl): string {
        this.tmpCount = 0;
        const retType   = cStructName(fn.returnType);
        const params    = fn.params.map(p => `${cStructName(p.resolvedType)} ${p.name}`);
        const fnName    = `_ms_${fn.name}`;
        const bodyLines = this.emitBody(fn.body, "    ", new Map(), fn.returnType);
        return `static ${retType} ${fnName}(${params.join(", ")}) {\n${bodyLines}\n}`;
    }

    // ── メイン ────────────────────────────────────────────────────────────────

    private emitMain(): string {
        if (!this.functions.has("main")) return "";
        return `int main(void) {\n    _ms_main();\n    return 0;\n}`;
    }

    // ── ボディ生成 ────────────────────────────────────────────────────────────

    private emitBody(nodes: ASTNode[], indent: string, subst: Map<string, string>, retMozType?: string): string {
        const stmts: string[] = [];
        for (const node of nodes) {
            this.emitBodyNode(node, indent, subst, stmts, retMozType);
        }
        return stmts.map(s => (s.startsWith("#") ? s : indent + s)).join("\n");
    }

    private emitBodyNode(
        node: ASTNode,
        indent: string,
        subst: Map<string, string>,
        out: string[],
        retMozType?: string,
    ): void {
        switch (node.type) {
            case "VarDecl": {
                const pre: string[] = [];
                const expr = this.flattenExpr(node.value, pre, subst);
                out.push(...pre);
                const ctype = cStructName(applySubst(node.resolvedType, subst));
                if (ctype === "void") { if (expr) out.push(`${expr};`); break; }
                out.push(`${ctype} ${node.name} = ${expr || "{ 0 }"};`);
                break;
            }

            case "Assign": {
                const pre: string[] = [];
                const lhs = this.emitLvalue(node.target);
                const rhs = this.flattenExpr(node.value, pre, subst);
                out.push(...pre);
                out.push(`${lhs} = ${rhs};`);
                break;
            }

            case "MethodCall": {
                const pre: string[] = [];
                const expr = this.flattenMethodCall(node as any, pre, subst);
                out.push(...pre);
                if (expr) out.push(`${expr};`);
                break;
            }

            case "Intrinsic": {
                const pre: string[] = [];
                const expr = this.flattenIntrinsic(node as any, pre, subst);
                out.push(...pre);
                if (expr) out.push(`${expr};`);
                break;
            }

            case "IfStmt": {
                const condPre: string[] = [];
                const cond = this.flattenCond(node.cond, condPre, subst);
                out.push(...condPre);
                out.push(`if (${cond}) {`);
                out.push(this.emitBody(node.body, indent, subst, retMozType));
                out.push(`}`);
                if (node.else) {
                    if (node.else.type === "IfStmt") {
                        const elseLines: string[] = [];
                        this.emitBodyNode(node.else as unknown as ASTNode, indent, subst, elseLines, retMozType);
                        const first = elseLines.shift() ?? "";
                        out.push(`else ${first.trimStart()}`);
                        out.push(...elseLines);
                    } else {
                        out.push(`else {`);
                        out.push(this.emitBody((node.else as any).body, indent, subst, retMozType));
                        out.push(`}`);
                    }
                }
                break;
            }

            case "WhileStmt": {
                const condPre: string[] = [];
                const cond = this.flattenCond(node.cond, condPre, subst);
                if (condPre.length === 0) {
                    out.push(`while (${cond}) {`);
                    out.push(this.emitBody(node.body, indent, subst, retMozType));
                    out.push(`}`);
                } else {
                    out.push(`while (1) {`);
                    condPre.forEach(s => out.push(`${indent}${s}`));
                    out.push(`${indent}if (!(${cond})) break;`);
                    out.push(this.emitBody(node.body, indent, subst, retMozType));
                    out.push(`}`);
                }
                break;
            }

            case "ForStmt": {
                out.push(`{`);
                const initPre: string[] = [];
                this.emitBodyNode(node.init, indent, subst, initPre, retMozType);
                initPre.forEach(s => out.push(`${indent}${s}`));

                const condPre: string[] = [];
                const cond = this.flattenCond(node.cond, condPre, subst);

                if (condPre.length === 0) {
                    out.push(`${indent}while (${cond}) {`);
                    out.push(this.emitBody(node.body, indent + "    ", subst, retMozType));
                    const updPre: string[] = [];
                    this.emitBodyNode(node.update, indent + "    ", subst, updPre, retMozType);
                    updPre.forEach(s => out.push(`${indent}    ${s}`));
                    out.push(`${indent}}`);
                } else {
                    out.push(`${indent}while (1) {`);
                    condPre.forEach(s => out.push(`${indent}    ${s}`));
                    out.push(`${indent}    if (!(${cond})) break;`);
                    out.push(this.emitBody(node.body, indent + "    ", subst, retMozType));
                    const updPre: string[] = [];
                    this.emitBodyNode(node.update, indent + "    ", subst, updPre, retMozType);
                    updPre.forEach(s => out.push(`${indent}    ${s}`));
                    out.push(`${indent}}`);
                }
                out.push(`}`);
                break;
            }

            case "ReturnStmt": {
                if (!node.value) { out.push(`return;`); break; }
                const pre: string[] = [];
                const expr    = this.flattenExpr(node.value, pre, subst);
                const exprMoz = (node.value as any).resolvedType as string ?? "_m32";
                out.push(...pre);
                // _m32 を返すが関数の返り値型が bits フィールドを持つラッパー型の場合は強制変換
                const resolvedRet = retMozType ? applySubst(retMozType, subst) : "";
                const resolvedExpr = applySubst(exprMoz, subst);
                if (resolvedRet && resolvedRet !== "_m32" && resolvedRet !== "void"
                    && resolvedExpr === "_m32"
                    && this.hasSimpleBitsField(resolvedRet)) {
                    const ct  = cStructName(resolvedRet);
                    const tmp = this.nextTmp();
                    out.push(`${ct} ${tmp}; memset(&${tmp}, 0, sizeof(${ct})); ${tmp}.bits = ${expr};`);
                    out.push(`return ${tmp};`);
                } else {
                    out.push(`return ${expr};`);
                }
                break;
            }

            case "BreakStmt":
                out.push(`break;`);
                break;

            default:
                break;
        }
    }

    // ── lvalue ────────────────────────────────────────────────────────────────

    private emitLvalue(node: ASTNode): string {
        if (node.type === "Identifier") {
            if (node.name === "this") return "(*self)";
            return node.name;
        }
        if (node.type === "MemberAccess") {
            if (node.receiver.type === "Identifier" && node.receiver.name === "this") {
                return `self->${node.member}`;
            }
            return `${this.emitLvalue(node.receiver)}.${node.member}`;
        }
        return "/* lvalue? */";
    }

    // ── 条件式（__builtin_if/__builtin_while）────────────────────────────────

    private flattenCond(node: ASTNode, pre: string[], subst: Map<string, string>): string {
        if (
            node.type === "Intrinsic" &&
            (node.name === "__builtin_if" || node.name === "__builtin_while")
        ) {
            const boolExpr = this.flattenExpr(node.args[0], pre, subst);
            const boolVar  = this.maybeTemp(boolExpr, "_ms_boolean", pre);
            return `${boolVar}.bits`;
        }
        // フォールバック: _m32 ならそのまま
        return this.flattenExpr(node, pre, subst);
    }

    // ── 式フラット化 ──────────────────────────────────────────────────────────

    private flattenExpr(node: ASTNode, pre: string[], subst: Map<string, string>): string {
        switch (node.type) {
            case "Identifier":
                if (node.name === "this") return "(*self)";
                return node.name;

            case "RawLiteral":
                return `(int32_t)${node.value}`;

            case "MemberAccess": {
                if (node.receiver.type === "Identifier" && node.receiver.name === "this") {
                    return `self->${node.member}`;
                }
                const recvExpr = this.flattenExpr(node.receiver, pre, subst);
                const recvVar  = this.maybeTemp(
                    recvExpr,
                    cStructName(applySubst((node.receiver as any).resolvedType ?? "i32", subst)),
                    pre,
                );
                return `${recvVar}.${node.member}`;
            }

            case "MethodCall":
                return this.flattenMethodCall(node as any, pre, subst);

            case "NewExpr":
                return this.flattenNewExpr(node as any, pre, subst);

            case "Intrinsic":
                return this.flattenIntrinsic(node as any, pre, subst);

            default:
                return "0";
        }
    }

    private flattenMethodCall(
        node: {
            type: "MethodCall"; resolvedType: string;
            receiver: ASTNode; method: string; args: ASTNode[];
        },
        pre: string[],
        subst: Map<string, string>,
    ): string {
        const recvType = applySubst((node.receiver as any).resolvedType ?? "void", subst);
        const recvAddr = this.flattenToAddr(node.receiver, recvType, pre, subst);
        const argExprs = node.args.map(a => this.flattenExpr(a, pre, subst));

        const fnName  = cMethodName(recvType, node.method);
        const allArgs = [recvAddr, ...argExprs].join(", ");
        const call    = `${fnName}(${allArgs})`;

        const retType = applySubst(node.resolvedType, subst);
        if (retType === "void") {
            pre.push(`${call};`);
            return "";
        }

        const tmp = this.nextTmp();
        pre.push(`${cStructName(retType)} ${tmp} = ${call};`);
        return tmp;
    }

    private flattenNewExpr(
        node: {
            type: "NewExpr"; resolvedType: string;
            args: ASTNode[]; elements?: { type: "RawLiteral"; value: number }[];
        },
        pre: string[],
        subst: Map<string, string>,
    ): string {
        const concreteType = applySubst(node.resolvedType, subst);
        const ctype        = cStructName(concreteType);
        const tmp          = this.nextTmp();

        // 文字列リテラル（elements あり）
        if (node.elements !== undefined) {
            const n = node.elements.length;
            pre.push(`${ctype} ${tmp};`);
            pre.push(`memset(&${tmp}, 0, sizeof(${ctype}));`);
            if (n > 0) {
                pre.push(`${tmp}.ptr = _ms_malloc((int32_t)(${n * 4}));`);
                for (let i = 0; i < n; i++) {
                    pre.push(`_ms_heap[${tmp}.ptr + ${i}] = (int32_t)${node.elements[i].value};`);
                }
            }
            pre.push(`${tmp}.length.bits = (int32_t)${n};`);
            return tmp;
        }

        // 通常のNewExpr
        pre.push(`${ctype} ${tmp};`);
        pre.push(`memset(&${tmp}, 0, sizeof(${ctype}));`);

        const ctorName = cMethodName(concreteType, "constructor");
        const argExprs = node.args.map(a => this.flattenExpr(a, pre, subst));
        const allArgs  = [`&${tmp}`, ...argExprs].join(", ");
        pre.push(`${ctorName}(${allArgs});`);

        return tmp;
    }

    private flattenIntrinsic(
        node: { type: "Intrinsic"; name: string; resolvedType: string; targetType?: string; args: ASTNode[] },
        pre: string[],
        subst: Map<string, string>,
    ): string {
        const a = (i: number) => this.flattenExpr(node.args[i], pre, subst);

        switch (node.name) {
            // i32
            case "__builtin_i32_add": return `(int32_t)((${a(0)}) + (${a(1)}))`;
            case "__builtin_i32_sub": return `(int32_t)((${a(0)}) - (${a(1)}))`;
            case "__builtin_i32_mul": return `(int32_t)((${a(0)}) * (${a(1)}))`;
            case "__builtin_i32_div": return `(int32_t)((${a(0)}) / (${a(1)}))`;
            case "__builtin_i32_mod": return `(int32_t)((${a(0)}) % (${a(1)}))`;
            case "__builtin_i32_neg": return `(int32_t)(-(${a(0)}))`;
            case "__builtin_i32_eq":  return `((${a(0)}) == (${a(1)}) ? 1 : 0)`;
            case "__builtin_i32_lt":  return `((${a(0)}) < (${a(1)}) ? 1 : 0)`;
            case "__builtin_i32_gt":  return `((${a(0)}) > (${a(1)}) ? 1 : 0)`;
            case "__builtin_i32_or":  return `((${a(0)}) | (${a(1)}))`;
            case "__builtin_i32_and": return `((${a(0)}) & (${a(1)}))`;
            case "__builtin_i32_not": return `((${a(0)}) == 0 ? 1 : 0)`;
            case "__builtin_i32_bitwise_and": return `((${a(0)}) & (${a(1)}))`;
            case "__builtin_i32_bitwise_or":  return `((${a(0)}) | (${a(1)}))`;
            case "__builtin_i32_bitwise_xor": return `((${a(0)}) ^ (${a(1)}))`;
            case "__builtin_i32_shift_left":  return `((${a(0)}) << (${a(1)}))`;
            case "__builtin_i32_shift_right": return `((${a(0)}) >> (${a(1)}))`;

            // u32
            case "__builtin_u32_add": return `(int32_t)((uint32_t)(${a(0)}) + (uint32_t)(${a(1)}))`;
            case "__builtin_u32_sub": return `(int32_t)((uint32_t)(${a(0)}) - (uint32_t)(${a(1)}))`;
            case "__builtin_u32_mul": return `(int32_t)((uint32_t)(${a(0)}) * (uint32_t)(${a(1)}))`;
            case "__builtin_u32_div": return `(int32_t)((uint32_t)(${a(0)}) / (uint32_t)(${a(1)}))`;
            case "__builtin_u32_mod": return `(int32_t)((uint32_t)(${a(0)}) % (uint32_t)(${a(1)}))`;
            case "__builtin_u32_eq":  return `((uint32_t)(${a(0)}) == (uint32_t)(${a(1)}) ? 1 : 0)`;
            case "__builtin_u32_lt":  return `((uint32_t)(${a(0)}) < (uint32_t)(${a(1)}) ? 1 : 0)`;
            case "__builtin_u32_gt":  return `((uint32_t)(${a(0)}) > (uint32_t)(${a(1)}) ? 1 : 0)`;
            case "__builtin_u32_bitwise_and": return `((${a(0)}) & (${a(1)}))`;
            case "__builtin_u32_bitwise_or":  return `((${a(0)}) | (${a(1)}))`;
            case "__builtin_u32_bitwise_xor": return `((${a(0)}) ^ (${a(1)}))`;
            case "__builtin_u32_shift_left":  return `((${a(0)}) << (${a(1)}))`;
            case "__builtin_u32_shift_right": return `(int32_t)((uint32_t)(${a(0)}) >> (${a(1)}))`;

            // f32
            case "__builtin_f32_add": return `_ms_f32_bits(_ms_bits_f32(${a(0)}) + _ms_bits_f32(${a(1)}))`;
            case "__builtin_f32_sub": return `_ms_f32_bits(_ms_bits_f32(${a(0)}) - _ms_bits_f32(${a(1)}))`;
            case "__builtin_f32_mul": return `_ms_f32_bits(_ms_bits_f32(${a(0)}) * _ms_bits_f32(${a(1)}))`;
            case "__builtin_f32_div": return `_ms_f32_bits(_ms_bits_f32(${a(0)}) / _ms_bits_f32(${a(1)}))`;
            case "__builtin_f32_mod": return `_ms_f32_bits(fmodf(_ms_bits_f32(${a(0)}), _ms_bits_f32(${a(1)})))`;
            case "__builtin_f32_eq":  return `(_ms_bits_f32(${a(0)}) == _ms_bits_f32(${a(1)}) ? 1 : 0)`;
            case "__builtin_f32_lt":  return `(_ms_bits_f32(${a(0)}) < _ms_bits_f32(${a(1)}) ? 1 : 0)`;
            case "__builtin_f32_gt":  return `(_ms_bits_f32(${a(0)}) > _ms_bits_f32(${a(1)}) ? 1 : 0)`;
            case "__builtin_f32_neg": return `_ms_f32_bits(-_ms_bits_f32(${a(0)}))`;

            // 型変換
            case "__builtin_i32_to_f32": return `_ms_f32_bits((float)(int32_t)(${a(0)}))`;
            case "__builtin_i32_to_u32": return `(int32_t)(uint32_t)(int32_t)(${a(0)})`;
            case "__builtin_u32_to_f32": return `_ms_f32_bits((float)(uint32_t)(${a(0)}))`;
            case "__builtin_u32_to_i32": return `(int32_t)(uint32_t)(${a(0)})`;
            case "__builtin_f32_to_i32": return `(int32_t)_ms_bits_f32(${a(0)})`;
            case "__builtin_f32_to_u32": return `(int32_t)(uint32_t)_ms_bits_f32(${a(0)})`;

            // メモリ
            case "__builtin_malloc":      return `_ms_malloc(${a(0)})`;
            case "__builtin_free":        { pre.push(`_ms_free(${a(0)});`); return ""; }
            case "__builtin_mem_read32":  return `_ms_mem_read32(${a(0)}, ${a(1)})`;
            case "__builtin_mem_write32": {
                const v2     = this.flattenExpr(node.args[2], pre, subst);
                const v2type = applySubst((node.args[2] as any).resolvedType ?? "_m32", subst);
                const v2bits = (v2type === "_m32") ? v2
                    : `(${this.maybeTemp(v2, cStructName(v2type), pre)}).bits`;
                pre.push(`_ms_mem_write32(${a(0)}, ${a(1)}, ${v2bits});`);
                return "";
            }
            case "__builtin_zeroinit":    return "(int32_t)0";
            case "__builtin_ptr_alloc":   return `_ms_malloc(${a(0)})`;
            case "__builtin_ptr_free":    { pre.push(`_ms_free(${a(0)});`); return ""; }
            case "__builtin_ptr_read":    return `_ms_mem_read32(${a(0)}, 0)`;
            case "__builtin_ptr_write":   { pre.push(`_ms_mem_write32(${a(0)}, 0, ${a(1)});`); return ""; }
            case "__builtin_mem_set":     {
                pre.push(`{ int32_t _ms_i; for(_ms_i=0;_ms_i<${a(2)};_ms_i++) _ms_heap[(${a(0)})+_ms_i]=${a(1)}; }`);
                return "";
            }

            // I/O
            case "__builtin_stdout_write": {
                const v0 = this.flattenExpr(node.args[0], pre, subst);
                const sv = this.maybeTemp(v0, cStructName(applySubst(
                    (node.args[0] as any).resolvedType ?? "Array<u32>", subst)), pre);
                pre.push(`_ms_write_str(${sv}.ptr, ${sv}.length.bits);`);
                return "";
            }
            case "__builtin_stderr_write": {
                const v0 = this.flattenExpr(node.args[0], pre, subst);
                const sv = this.maybeTemp(v0, cStructName(applySubst(
                    (node.args[0] as any).resolvedType ?? "Array<u32>", subst)), pre);
                pre.push(`_ms_write_str_err(${sv}.ptr, ${sv}.length.bits);`);
                return "";
            }
            case "__builtin_panic": {
                const v0 = this.flattenExpr(node.args[0], pre, subst);
                const sv = this.maybeTemp(v0, cStructName(applySubst(
                    (node.args[0] as any).resolvedType ?? "Array<u32>", subst)), pre);
                pre.push(`_ms_panic_str(${sv}.ptr, ${sv}.length.bits);`);
                return "";
            }
            case "__builtin_stdin_readline": {
                pre.push(`fprintf(stderr, "[PANIC] __builtin_stdin_readline not supported\\n"); exit(1);`);
                const rtmp = this.nextTmp();
                pre.push(`_ms_Array_u32 ${rtmp}; memset(&${rtmp}, 0, sizeof(_ms_Array_u32));`);
                return rtmp;
            }

            case "__builtin_str_length": {
                const v0 = this.flattenExpr(node.args[0], pre, subst);
                const sv = this.maybeTemp(v0, cStructName(applySubst(
                    (node.args[0] as any).resolvedType ?? "Array<u32>", subst)), pre);
                return `${sv}.length.bits`;
            }

            // sizeof
            case "__builtin_sizeof":
                return `(int32_t)${this.computeSizeof(applySubst(node.targetType ?? "i32", subst))}`;

            default:
                return `(int32_t)0 /* unknown builtin: ${node.name} */`;
        }
    }

    // ── ヘルパー ──────────────────────────────────────────────────────────────

    private flattenToAddr(
        node: ASTNode,
        resolvedType: string,
        pre: string[],
        subst: Map<string, string>,
    ): string {
        if (node.type === "Identifier" && node.name === "this") return "self";
        if (node.type === "Identifier") return `&${node.name}`;
        if (node.type === "MemberAccess") {
            const access = this.flattenExpr(node, pre, subst);
            // MemberAccess は常に左辺値なので & が取れる
            return `&(${access})`;
        }
        // 複雑な式はテンポラリに落とす
        const expr = this.flattenExpr(node, pre, subst);
        const tmp  = this.nextTmp();
        pre.push(`${cStructName(resolvedType)} ${tmp} = ${expr};`);
        return `&${tmp}`;
    }

    private maybeTemp(expr: string, ctype: string, pre: string[]): string {
        // 単純な識別子 or self->field はそのまま返す
        if (/^[_a-zA-Z][_a-zA-Z0-9]*$/.test(expr)) return expr;
        if (/^self->/.test(expr)) return expr;
        const tmp = this.nextTmp();
        pre.push(`${ctype} ${tmp} = ${expr};`);
        return tmp;
    }

    private nextTmp(): string {
        return `_tmp${this.tmpCount++}`;
    }

    // _m32 bits フィールドを1つだけ持つラッパー型か判定
    private hasSimpleBitsField(mozType: string): boolean {
        const base = baseType(mozType);
        const cls  = this.classes.get(base);
        if (!cls) return false;
        const privateFields = cls.members.filter(f => f.access === "private");
        return privateFields.length === 1
            && privateFields[0].name === "bits"
            && privateFields[0].resolvedType === "_m32";
    }

    private computeSizeof(mozType: string): number {
        const base = baseType(mozType);
        const cls  = this.classes.get(base);
        if (!cls) return 4;
        let total = 0;
        for (const field of cls.members) {
            if (field.access !== "private") continue;
            switch (field.resolvedType) {
                case "_m32":  total += 4;  break;
                case "_m64":  total += 8;  break;
                case "_m128": total += 16; break;
                case "_m256": total += 32; break;
            }
        }
        return total > 0 ? total : 4;
    }
}
