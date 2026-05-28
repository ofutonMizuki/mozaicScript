// wasmcodegen/codegen.ts — mozaicScript IR → WebAssembly (binary .wasm)
//
// 設計方針:
//   - 値の WASM 型は機械型で決まる: _m8/_m16/_m32 → i32, _m64 → i64。
//     f32/f64 は「ビット列」を i32/i64 に保持し、演算時のみ reinterpret する
//     （C バックエンドと同じ表現）。
//   - ラッパークラス (単一の _mXX フィールド: i32/u32/f32/boolean/i64/...) は
//     裸の値 (i32/i64) として扱う（JS バックエンドと同じ）。
//   - 参照型（多フィールド or 非機械単一フィールド: Vec2/Array/Option/... ）は
//     線形メモリ上にバンプ確保し、バイトアドレス (i32) のポインタで受け渡す
//     （C の参照セマンティクスを線形メモリ上で再現）。
//   - malloc / __builtin_mem_* が返す「ポインタ」はワードインデックス (= byte/4)
//     で IR の規約に合わせる。オブジェクト参照はバイトアドレス。
//   - ジェネリックは具体型ごとに monomorphize する。
//   - I/O・超越関数はホスト import に委譲する。

import * as fs from "fs";
import * as nodePath from "path";
import { ASTNode, ClassDecl, FunctionDecl, MozaicScriptAST } from "../interpreter/types";
import { ModuleBuilder, FuncBuilder, OP, ValType } from "./encoder";

type WType = "i32" | "i64";
const VOID = "void" as const;
type EType = WType | typeof VOID;

// ── 型ユーティリティ ──────────────────────────────────────────────────────────

// 参照修飾子 (& / &mut) を剥がす。コード生成時には参照と所有権の区別は消える
function stripRef(t: string): string {
    if (t.startsWith("&mut ")) return t.slice(5);
    if (t.startsWith("&"))     return t.slice(1);
    return t;
}
function baseType(t: string): string {
    const s = stripRef(t);
    const lt = s.indexOf("<");
    return lt === -1 ? s : s.slice(0, lt);
}
function typeArgs(t: string): string[] {
    const s = stripRef(t);
    const lt = s.indexOf("<");
    if (lt === -1) return [];
    const inner = s.slice(lt + 1, s.lastIndexOf(">"));
    const res: string[] = [];
    let depth = 0, start = 0;
    for (let i = 0; i < inner.length; i++) {
        if (inner[i] === "<") depth++;
        else if (inner[i] === ">") depth--;
        else if (inner[i] === "," && depth === 0) { res.push(inner.slice(start, i).trim()); start = i + 1; }
    }
    const last = inner.slice(start).trim();
    if (last) res.push(last);
    return res;
}
function applySubst(t: string, subst: Map<string, string>): string {
    const stripped = stripRef(t);
    const direct = subst.get(stripped);
    if (direct !== undefined) return direct;
    const base = baseType(stripped);
    const args = typeArgs(stripped);
    if (args.length === 0) return stripped;
    return `${base}<${args.map(a => applySubst(a, subst)).join(",")}>`;
}

const MACHINE = new Set(["_m8", "_m16", "_m32", "_m64", "_m128", "_m256", "_m512"]);
const MACHINE_SIZE: Record<string, number> = {
    _m8: 1, _m16: 2, _m32: 4, _m64: 8, _m128: 16, _m256: 32, _m512: 64,
};

// 浮動小数点の機械幅判定（リテラル幅選択用）。f32 のビットは _m32、f64 は _m64。
function f32BitsOf(x: number): number { const b = new Float32Array([x]); return new Int32Array(b.buffer)[0]; }
function f64BitsOf(x: number): bigint { const b = new Float64Array([x]); return new BigInt64Array(b.buffer)[0]; }

// 演算子名 → ユニークキー用サフィックス
const OP_MAP: Record<string, string> = {
    "operator+": "op_add", "operator-": "op_sub", "operator*": "op_mul", "operator/": "op_div",
    "operator%": "op_mod", "operator==": "op_eq", "operator<": "op_lt", "operator>": "op_gt",
    "operator||": "op_or", "operator&&": "op_and", "operatorNot": "op_not",
    "operator[]": "op_idx_get", "operator_set[]": "op_idx_set", "constructor": "ctor",
};

// 飽和切り捨て (0xFC prefix)
const TRUNC_SAT: Record<string, number> = {
    i32_f32_s: 0x00, i32_f32_u: 0x01, i32_f64_s: 0x02, i32_f64_u: 0x03,
    i64_f32_s: 0x04, i64_f32_u: 0x05, i64_f64_s: 0x06, i64_f64_u: 0x07,
};

interface WrapperInfo { field: string; bits: string; }
interface FieldLayout { offset: number; mozType: string; wtype: WType; ref: boolean; size: number; }
interface Layout { size: number; fields: Map<string, FieldLayout>; }

// 関数発行スペック
interface FnSpec {
    key: string;
    fb: FuncBuilder;
    index: number;
    fn: FunctionDecl;
    recvType?: string;      // メソッドの具体レシーバ型（free fn は undefined）
    subst: Map<string, string>;
}

// ── WasmCodegen ─────────────────────────────────────────────────────────────

export class WasmCodegen {
    private classes = new Map<string, ClassDecl>();
    private functions = new Map<string, FunctionDecl>();
    private globalsDecl = new Map<string, { type: string; value: ASTNode }>();
    private typeAliases = new Map<string, string>();
    private wrappers = new Map<string, WrapperInfo>();
    private genericInsts = new Set<string>();
    private genericFuncInsts = new Map<string, Set<string>>();
    private loadedFiles = new Set<string>();

    private layouts = new Map<string, Layout>();

    private mod = new ModuleBuilder();
    private heapNextGlobal = 0;
    private syncNextGlobal = 0;
    private allocIdx = 0;
    private mallocIdx = 0;
    private callByNameIdx = 0;

    // imports
    private imp: Record<string, number> = {};

    // function key → index
    private fnIndex = new Map<string, number>();
    private specs: FnSpec[] = [];

    // globals: name → {idx, wtype}
    private gvar = new Map<string, { idx: number; wtype: WType }>();

    // ── AST 読み込み ──────────────────────────────────────────────────────────

    loadAST(filePath: string): void {
        if (this.loadedFiles.has(filePath)) return;
        this.loadedFiles.add(filePath);
        const ast: MozaicScriptAST = JSON.parse(fs.readFileSync(filePath + ".ast.json", "utf-8"));
        for (const node of ast.nodes) {
            if (node.type === "ImportDecl") {
                this.loadAST(nodePath.resolve(nodePath.dirname(filePath), node.path));
            }
        }
        for (const node of ast.nodes) {
            if (node.type === "ClassDecl") this.classes.set(node.name, node);
            else if (node.type === "FunctionDecl") this.functions.set(node.name, node);
            else if (node.type === "TypeAliasDecl") this.typeAliases.set(node.name, node.resolvedType);
            else if (node.type === "VarDecl") this.globalsDecl.set(node.name, { type: node.resolvedType, value: node.value });
        }
        this.scanGenericInsts(ast.nodes);
    }

    // ── ジェネリック収集 ──────────────────────────────────────────────────────

    private scanGenericInsts(nodes: ASTNode[]): void { for (const n of nodes) this.scanNode(n, new Set()); }
    private collectType(t: string, ex: Set<string>): void {
        const base = baseType(t);
        if (ex.has(base)) return;
        const args = typeArgs(t);
        if (args.length > 0 && !args.some(a => ex.has(baseType(a)))) {
            this.genericInsts.add(t);
            args.forEach(a => this.collectType(a, ex));
        }
    }
    private scanNode(node: ASTNode, ex: Set<string>): void {
        if (!node) return;
        switch (node.type) {
            case "ClassDecl": {
                const e = new Set([...ex, ...node.typeParams]);
                node.members.forEach(m => this.collectType(m.resolvedType, e));
                node.methods.forEach(m => m.body.forEach(n => this.scanNode(n, e)));
                break;
            }
            case "FunctionDecl": node.body.forEach(n => this.scanNode(n, ex)); break;
            case "VarDecl": this.collectType(node.resolvedType, ex); this.scanNode(node.value, ex); break;
            case "NewExpr":
                this.collectType(node.resolvedType, ex);
                (node.args ?? []).forEach(a => this.scanNode(a, ex));
                break;
            case "MethodCall": {
                this.collectType(node.resolvedType, ex);
                this.collectType((node.receiver as any).resolvedType ?? "", ex);
                this.scanNode(node.receiver, ex);
                node.args.forEach(a => this.scanNode(a, ex));
                if (node.receiver.type === "Identifier") {
                    const rname = (node.receiver as any).name as string;
                    const simple = rname.includes(".") ? rname.slice(rname.lastIndexOf(".") + 1) : rname;
                    const fn = this.functions.get(simple);
                    if (fn && fn.typeParams.length > 0) {
                        const concreteT = (node.receiver as any).resolvedType as string;
                        if (concreteT && !ex.has(concreteT) && concreteT !== simple) {
                            if (!this.genericFuncInsts.has(simple)) this.genericFuncInsts.set(simple, new Set());
                            this.genericFuncInsts.get(simple)!.add(concreteT);
                        }
                    }
                }
                break;
            }
            case "Intrinsic": this.collectType(node.resolvedType, ex); node.args.forEach(a => this.scanNode(a, ex)); break;
            case "MemberAccess": this.collectType(node.resolvedType, ex); this.scanNode(node.receiver, ex); break;
            case "BorrowExpr": this.scanNode((node as any).expr, ex); break;
            case "Assign": this.scanNode(node.target, ex); this.scanNode(node.value, ex); break;
            case "IfStmt": this.scanNode(node.cond, ex); node.body.forEach(n => this.scanNode(n, ex)); if (node.else) this.scanNode(node.else as any, ex); break;
            case "ElseStmt": node.body.forEach(n => this.scanNode(n, ex)); break;
            case "WhileStmt": this.scanNode(node.cond, ex); node.body.forEach(n => this.scanNode(n, ex)); break;
            case "ForStmt": this.scanNode(node.init, ex); this.scanNode(node.cond, ex); this.scanNode(node.update, ex); node.body.forEach(n => this.scanNode(n, ex)); break;
            case "ReturnStmt": if (node.value) this.scanNode(node.value, ex); break;
            case "BlockStmt": node.body.forEach(n => this.scanNode(n, ex)); break;
        }
    }

    // ── ラッパー検出 ─────────────────────────────────────────────────────────

    private detectWrappers(): void {
        for (const [name, cls] of this.classes) {
            const privs = cls.members.filter(m => m.access === "private" || m.access === "mocp public");
            if (privs.length === 1 && privs[0].resolvedType.startsWith("_m")) {
                // ラッパー判定の追加条件 (JS バックエンドと同じ): constructor が 1 個の _mXX
                // 引数を取り直接フィールド代入する素通しパターンであること。
                // GpuArgs のように () コンストラクタ内で intrinsic を呼ぶ初期化型は除外する。
                const ctor = cls.methods.find(m => m.name === "constructor");
                if (!ctor || ctor.params.length !== 1) continue;
                if (!ctor.params[0].resolvedType.startsWith("_m")) continue;
                // ジェネリック wrapper (Ptr<T> 等) も含める。インスタンス側 (Ptr<f32>) の
                // baseType でも同じ wrapper エントリを共有する。
                this.wrappers.set(name, { field: privs[0].name, bits: privs[0].resolvedType });
            }
        }
    }

    // ── 型ヘルパー ────────────────────────────────────────────────────────────

    private resolveAlias(t: string): string {
        let cur = t; const seen = new Set<string>();
        while (this.typeAliases.has(cur) && !seen.has(cur)) { seen.add(cur); cur = this.typeAliases.get(cur)!; }
        return cur;
    }
    private isWrapper(t: string): WrapperInfo | undefined { return this.wrappers.get(baseType(this.resolveAlias(t))); }
    private isRef(t: string): boolean {
        const r = this.resolveAlias(t);
        if (r === "void" || MACHINE.has(r)) return false;
        const cls = this.classes.get(baseType(r));
        if (!cls) return false;
        if (cls.members.length === 1 && MACHINE.has(this.resolveAlias(cls.members[0].resolvedType))) return false;
        return true;
    }
    // 値の WASM 型。void では呼ばない。
    private wtype(t: string): WType {
        const r = this.resolveAlias(t);
        if (MACHINE.has(r)) return r === "_m64" ? "i64" : "i32";
        if (this.isRef(r)) return "i32";
        const w = this.isWrapper(r);
        if (w) return w.bits === "_m64" ? "i64" : "i32";
        return "i32";
    }
    // 機械型文字列（リテラル幅選択用）。ラッパー→bits、機械→自身、その他→null。
    private targetMachine(t: string): string | null {
        const r = this.resolveAlias(t);
        if (MACHINE.has(r)) return r;
        const w = this.isWrapper(r);
        if (w) return w.bits;
        return null;
    }
    private machineSize(t: string): number {
        const r = this.resolveAlias(t);
        if (MACHINE.has(r)) return MACHINE_SIZE[r];
        const w = this.isWrapper(r);
        if (w) return MACHINE_SIZE[w.bits];
        if (this.isRef(r)) return 4; // pointer (byte addr) = i32
        return 4;
    }
    private computeSizeof(t: string): number {
        const r = this.resolveAlias(t);
        if (MACHINE.has(r)) return MACHINE_SIZE[r];
        const w = this.isWrapper(r);
        if (w) return MACHINE_SIZE[w.bits];
        if (this.isRef(r)) return 4;
        return 4;
    }

    private getLayout(concreteType: string): Layout {
        const r = this.resolveAlias(concreteType);
        const cached = this.layouts.get(r);
        if (cached) return cached;
        const base = baseType(r), args = typeArgs(r);
        const cls = this.classes.get(base);
        const fields = new Map<string, FieldLayout>();
        if (!cls) { const lay = { size: 4, fields }; this.layouts.set(r, lay); return lay; }
        const subst = new Map<string, string>();
        cls.typeParams.forEach((p, i) => subst.set(p, args[i] ?? p));
        let cursor = 0;
        for (const m of cls.members) {
            const fmoz = this.resolveAlias(applySubst(m.resolvedType, subst));
            const ref = this.isRef(fmoz);
            const size = ref ? 4 : this.machineSize(fmoz);
            const align = size >= 8 ? 8 : 4;
            const offset = Math.ceil(cursor / align) * align;
            fields.set(m.name, { offset, mozType: fmoz, wtype: ref ? "i32" : this.wtype(fmoz), ref, size });
            cursor = offset + size;
        }
        const lay = { size: Math.ceil(cursor / 8) * 8 || 8, fields };
        this.layouts.set(r, lay);
        return lay;
    }

    private arrayFields(): { ptr: string; length: string } {
        const cls = this.classes.get("Array");
        if (!cls) return { ptr: "ptr", length: "length" };
        const ptrF = cls.members.find(m => m.resolvedType === "_m32" && m.access === "private");
        const lenF = cls.members.find(m => m !== ptrF);
        return { ptr: ptrF?.name ?? "ptr", length: lenF?.name ?? "length" };
    }

    // ── 関数キー ──────────────────────────────────────────────────────────────

    private methodKey(recvType: string, method: string): string {
        return `m|${this.resolveAlias(recvType)}|${OP_MAP[method] ?? method}`;
    }
    private fnKey(name: string, concreteT?: string): string {
        return concreteT ? `f|${name}|${concreteT}` : `f|${name}`;
    }

    // ── エミット本体 ──────────────────────────────────────────────────────────

    emit(): Uint8Array {
        this.detectWrappers();

        // memory + globals
        this.mod.setMemory(256); // 16 MiB 初期、必要に応じ grow
        this.heapNextGlobal = this.mod.addGlobal("i32", true, 4); // 0 = null, 先頭ワード予約
        this.syncNextGlobal = this.mod.addGlobal("i32", true, 1);

        // imports（全 import をユーザ関数より前に登録）
        this.imp.stdout = this.mod.addImport("env", "stdout_write", ["i32", "i32"], []);
        this.imp.stderr = this.mod.addImport("env", "stderr_write", ["i32", "i32"], []);
        this.imp.panic = this.mod.addImport("env", "panic", ["i32", "i32"], []);
        for (const name of ["sin", "cos", "tan", "exp", "log", "atan"]) {
            this.imp[name] = this.mod.addImport("env", name, ["f64"], ["f64"]);
        }
        this.imp.pow = this.mod.addImport("env", "pow", ["f64", "f64"], ["f64"]);
        this.imp.atan2 = this.mod.addImport("env", "atan2", ["f64", "f64"], ["f64"]);
        this.imp.fmod = this.mod.addImport("env", "fmod", ["f64", "f64"], ["f64"]);

        // ── GPU エミュレーション env imports ───────────────────────────────
        // 仕様: doc/mozaicScript-spec.md §14 / doc/mozaicScript-corelib-spec.md §8
        // 実体は wasmcodegen/run.js が JS で提供する (CPU 同期実行)。
        this.imp.gpu_is_available    = this.mod.addImport("env", "gpu_is_available", [], ["i32"]);
        this.imp.gpu_buf_create      = this.mod.addImport("env", "gpu_buffer_create", ["i64"], ["i64"]);
        this.imp.gpu_buf_map_write   = this.mod.addImport("env", "gpu_buffer_map_write", ["i64"], ["i32"]);
        this.imp.gpu_buf_map_read    = this.mod.addImport("env", "gpu_buffer_map_read", ["i64"], ["i32"]);
        this.imp.gpu_buf_unmap       = this.mod.addImport("env", "gpu_buffer_unmap", ["i64"], []);
        this.imp.gpu_buf_byte_size   = this.mod.addImport("env", "gpu_buffer_byte_size", ["i64"], ["i64"]);
        this.imp.gpu_buf_free        = this.mod.addImport("env", "gpu_buffer_free", ["i64"], []);
        this.imp.gpu_kern_handle     = this.mod.addImport("env", "gpu_kernel_handle", ["i32"], ["i64"]);
        this.imp.gpu_kern_wgx        = this.mod.addImport("env", "gpu_kernel_wgx", ["i64"], ["i32"]);
        this.imp.gpu_kern_wgy        = this.mod.addImport("env", "gpu_kernel_wgy", ["i64"], ["i32"]);
        this.imp.gpu_kern_wgz        = this.mod.addImport("env", "gpu_kernel_wgz", ["i64"], ["i32"]);
        this.imp.gpu_args_create     = this.mod.addImport("env", "gpu_args_create", [], ["i64"]);
        this.imp.gpu_args_push_buf   = this.mod.addImport("env", "gpu_args_push_buffer", ["i64", "i64"], []);
        this.imp.gpu_args_push_i32   = this.mod.addImport("env", "gpu_args_push_i32", ["i64", "i32"], []);
        this.imp.gpu_args_push_i64   = this.mod.addImport("env", "gpu_args_push_i64", ["i64", "i64"], []);
        this.imp.gpu_args_count      = this.mod.addImport("env", "gpu_args_count", ["i64"], ["i32"]);
        this.imp.gpu_args_clear      = this.mod.addImport("env", "gpu_args_clear", ["i64"], []);
        this.imp.gpu_dispatch        = this.mod.addImport("env", "gpu_dispatch", ["i64", "i64", "i32", "i32", "i32"], []);
        this.imp.gpu_sync            = this.mod.addImport("env", "gpu_sync", [], []);
        this.imp.gpu_flush           = this.mod.addImport("env", "gpu_flush", [], []);
        // gpu_register_kernel(idx, wgx, wgy, wgz)
        this.imp.gpu_register_kernel = this.mod.addImport("env", "gpu_register_kernel", ["i32", "i32", "i32", "i32"], []);
        this.imp.gpu_tid_gix = this.mod.addImport("env", "gpu_tid_gix", [], ["i32"]);
        this.imp.gpu_tid_giy = this.mod.addImport("env", "gpu_tid_giy", [], ["i32"]);
        this.imp.gpu_tid_giz = this.mod.addImport("env", "gpu_tid_giz", [], ["i32"]);
        this.imp.gpu_tid_lix = this.mod.addImport("env", "gpu_tid_lix", [], ["i32"]);
        this.imp.gpu_tid_liy = this.mod.addImport("env", "gpu_tid_liy", [], ["i32"]);
        this.imp.gpu_tid_liz = this.mod.addImport("env", "gpu_tid_liz", [], ["i32"]);
        this.imp.gpu_tid_wix = this.mod.addImport("env", "gpu_tid_wix", [], ["i32"]);
        this.imp.gpu_tid_wiy = this.mod.addImport("env", "gpu_tid_wiy", [], ["i32"]);
        this.imp.gpu_tid_wiz = this.mod.addImport("env", "gpu_tid_wiz", [], ["i32"]);
        this.imp.gpu_tid_wgx = this.mod.addImport("env", "gpu_tid_wgx", [], ["i32"]);
        this.imp.gpu_atomic_add_u32  = this.mod.addImport("env", "gpu_atomic_add_u32", ["i32", "i32"], ["i32"]);
        this.imp.gpu_atomic_sub_u32  = this.mod.addImport("env", "gpu_atomic_sub_u32", ["i32", "i32"], ["i32"]);
        this.imp.gpu_atomic_min_u32  = this.mod.addImport("env", "gpu_atomic_min_u32", ["i32", "i32"], ["i32"]);
        this.imp.gpu_atomic_max_u32  = this.mod.addImport("env", "gpu_atomic_max_u32", ["i32", "i32"], ["i32"]);
        this.imp.gpu_atomic_cas_u32  = this.mod.addImport("env", "gpu_atomic_cas_u32", ["i32", "i32", "i32"], ["i32"]);
        this.imp.gpu_atomic_load_u32 = this.mod.addImport("env", "gpu_atomic_load_u32", ["i32"], ["i32"]);
        this.imp.gpu_atomic_store_u32= this.mod.addImport("env", "gpu_atomic_store_u32", ["i32", "i32"], []);
        this.imp.gpu_atomic_add_i32  = this.mod.addImport("env", "gpu_atomic_add_i32", ["i32", "i32"], ["i32"]);
        this.imp.gpu_atomic_sub_i32  = this.mod.addImport("env", "gpu_atomic_sub_i32", ["i32", "i32"], ["i32"]);
        this.imp.gpu_atomic_min_i32  = this.mod.addImport("env", "gpu_atomic_min_i32", ["i32", "i32"], ["i32"]);
        this.imp.gpu_atomic_max_i32  = this.mod.addImport("env", "gpu_atomic_max_i32", ["i32", "i32"], ["i32"]);
        this.imp.gpu_atomic_cas_i32  = this.mod.addImport("env", "gpu_atomic_cas_i32", ["i32", "i32", "i32"], ["i32"]);
        this.imp.gpu_atomic_load_i32 = this.mod.addImport("env", "gpu_atomic_load_i32", ["i32"], ["i32"]);
        this.imp.gpu_atomic_store_i32= this.mod.addImport("env", "gpu_atomic_store_i32", ["i32", "i32"], []);
        // f32 は bit pattern (i32) で受け渡し (WASM codegen の通常規約に合わせる)
        this.imp.gpu_fma             = this.mod.addImport("env", "gpu_fma", ["i32", "i32", "i32"], ["i32"]);
        this.imp.gpu_dot_f32x4       = this.mod.addImport("env", "gpu_dot_f32x4", ["i32", "i32"], ["i32"]);
        this.imp.gpu_kernel_name     = this.mod.addImport("env", "gpu_kernel_name", ["i64"], ["i32"]);

        // runtime: alloc_bytes, malloc
        this.allocIdx = this.buildAllocBytes();
        this.mallocIdx = this.buildMalloc();

        // 関数インデックスを先に予約（再帰・相互参照のため）
        this.reserveFunctions();

        // グローバル変数を先に確保（関数本体から参照できるように）
        this.createGlobals();

        // 関数名→呼び出しディスパッチ（thread spawn / pool submit を同期実行する）
        this.callByNameIdx = this.buildCallByName();

        // 各関数本体を発行
        for (const spec of this.specs) this.emitFunctionBody(spec);

        // globals 初期化関数 + 合成 main
        const initIdx = this.emitInitGlobals();
        const mainIdx = this.emitSyntheticMain(initIdx);

        this.mod.exportMemory("memory");
        this.mod.exportFunc("main", mainIdx);
        // gpu_buffer_create が JS env から呼ぶための malloc を export する
        this.mod.exportFunc("_ms_malloc", this.mallocIdx);
        return this.mod.encode();
    }

    // ── runtime 関数 ──────────────────────────────────────────────────────────

    private growIfNeeded(fb: FuncBuilder): void {
        fb.global_get(this.heapNextGlobal);
        fb.memory_size().i32_const(16).emit(OP.i32_shl); // size*65536
        fb.emit(OP.i32_gt_u);
        fb.if_void();
        fb.global_get(this.heapNextGlobal);
        fb.memory_size().i32_const(16).emit(OP.i32_shl);
        fb.emit(OP.i32_sub);                 // deficit bytes
        fb.i32_const(65535).emit(OP.i32_add);
        fb.i32_const(16).emit(OP.i32_shr_u); // pages
        fb.memory_grow().drop();
        fb.end();
    }

    private buildAllocBytes(): number {
        const fb = new FuncBuilder(["i32"], ["i32"]); // (nbytes) -> byteAddr
        const addr = fb.addLocal("i32");
        fb.global_get(this.heapNextGlobal); fb.local_set(addr);
        // heap_next = addr + ((nbytes+3) & ~3)
        fb.local_get(addr);
        fb.local_get(0).i32_const(3).emit(OP.i32_add).i32_const(-4).emit(OP.i32_and);
        fb.emit(OP.i32_add);
        fb.global_set(this.heapNextGlobal);
        this.growIfNeeded(fb);
        fb.local_get(addr);
        return this.mod.addFunc(fb);
    }
    private buildMalloc(): number {
        const fb = new FuncBuilder(["i32"], ["i32"]); // (nbytes) -> wordIndex
        fb.local_get(0).call(this.allocIdx).i32_const(2).emit(OP.i32_shr_u);
        return this.mod.addFunc(fb);
    }

    // 関数名(文字列)→呼び出し: thread spawn / pool submit を同期実行（JS バックエンドと同じ）。
    // void かつ引数なしのトップレベル関数を候補に、名前一致で call する。
    private buildCallByName(): number {
        const fb = new FuncBuilder(["i32", "i32"], []); // (ptrWord, len) -> void
        const base = fb.addLocal("i32");
        fb.local_get(0).i32_const(2).emit(OP.i32_shl).local_set(base); // byte base
        for (const [name, fn] of this.functions) {
            if (fn.typeParams.length > 0 || fn.params.length > 0) continue;
            if (this.resolveAlias(fn.returnType) !== "void") continue;
            const idx = this.fnIndex.get(this.fnKey(name));
            if (idx === undefined) continue;
            fb.block_void();
            fb.local_get(1).i32_const(name.length).emit(OP.i32_ne).br_if(0);
            for (let i = 0; i < name.length; i++) {
                fb.local_get(base).load(OP.i32_load, 2, i * 4);
                fb.i32_const(name.charCodeAt(i)).emit(OP.i32_ne).br_if(0);
            }
            fb.call(idx).return_();
            fb.end();
        }
        return this.mod.addFunc(fb);
    }

    // ── 関数予約 ──────────────────────────────────────────────────────────────

    private sigOf(fn: FunctionDecl, recvType: string | undefined, subst: Map<string, string>): { params: ValType[]; results: ValType[] } {
        const params: ValType[] = [];
        if (recvType !== undefined) params.push(this.isRef(recvType) ? "i32" : this.wtype(recvType));
        for (const p of fn.params) params.push(this.wtype(applySubst(p.resolvedType, subst)));
        const ret = applySubst(fn.returnType, subst);
        const results: ValType[] = (fn.name === "constructor" || this.resolveAlias(ret) === "void") ? [] : [this.wtype(ret)];
        return { params, results };
    }

    private reserve(key: string, fn: FunctionDecl, recvType: string | undefined, subst: Map<string, string>): void {
        if (this.fnIndex.has(key)) return;
        const sig = this.sigOf(fn, recvType, subst);
        const fb = new FuncBuilder(sig.params, sig.results);
        const index = this.mod.addFunc(fb);
        this.fnIndex.set(key, index);
        this.specs.push({ key, fb, index, fn, recvType, subst });
    }

    private reserveFunctions(): void {
        // 非ジェネリッククラスのメソッド（ラッパー含む）
        for (const [name, cls] of this.classes) {
            if (cls.typeParams.length > 0) continue;
            for (const m of cls.methods) this.reserve(this.methodKey(name, m.name), m, name, new Map());
        }
        // ジェネリックインスタンスのメソッド
        for (const inst of this.genericInsts) {
            const base = baseType(inst), args = typeArgs(inst);
            const cls = this.classes.get(base);
            if (!cls || cls.typeParams.length === 0) continue;
            const subst = new Map<string, string>();
            cls.typeParams.forEach((p, i) => subst.set(p, args[i] ?? p));
            for (const m of cls.methods) this.reserve(this.methodKey(inst, m.name), m, inst, subst);
        }
        // free 関数
        for (const [name, fn] of this.functions) {
            if (fn.typeParams.length > 0) {
                const insts = this.genericFuncInsts.get(name);
                if (!insts) continue;
                for (const concreteT of insts) {
                    const subst = new Map<string, string>();
                    fn.typeParams.forEach(p => subst.set(p, concreteT));
                    this.reserve(this.fnKey(name, concreteT), fn, undefined, subst);
                }
            } else {
                this.reserve(this.fnKey(name), fn, undefined, new Map());
            }
        }
    }

    // ── 関数本体 ──────────────────────────────────────────────────────────────

    private emitFunctionBody(spec: FnSpec): void {
        const ctx = new FnCtx(spec.fb, spec.subst, spec.recvType, this.resolveAlias(applySubst(spec.fn.returnType, spec.subst)));
        // パラメータをスコープに登録
        let idx = 0;
        if (spec.recvType !== undefined) { ctx.scopes[0].set("this", { idx: 0, wtype: this.isRef(spec.recvType) ? "i32" : this.wtype(spec.recvType) }); idx = 1; }
        for (const p of spec.fn.params) {
            const t = applySubst(p.resolvedType, spec.subst);
            ctx.scopes[0].set(p.name, { idx, wtype: this.wtype(t) });
            idx++;
        }
        for (const stmt of spec.fn.body) this.emitStmt(stmt, ctx);
        // 値返し関数で本体末尾に到達しうる場合の安全網
        if (spec.fb.results.length > 0) spec.fb.unreachable();
    }

    private createGlobals(): void {
        for (const [name, g] of this.globalsDecl) {
            const wt = this.wtype(g.type);
            const gidx = this.mod.addGlobalZero(wt);
            this.gvar.set(name, { idx: gidx, wtype: wt });
        }
    }

    private emitInitGlobals(): number {
        const fb = new FuncBuilder([], []);
        if (this.globalsDecl.size === 0) return this.mod.addFunc(fb);
        const ctx = new FnCtx(fb, new Map(), undefined, "void");
        for (const [name, g] of this.globalsDecl) {
            this.emitExprAs(g.value, g.type, ctx);
            fb.global_set(this.gvar.get(name)!.idx);
        }
        return this.mod.addFunc(fb);
    }

    private emitSyntheticMain(initIdx: number): number {
        const fb = new FuncBuilder([], []);
        // gpu カーネル登録 (init より前に: globals 初期化が __builtin_gpu_kernel_handle を呼ぶ可能性があるため)
        let kIdx = 0;
        for (const spec of this.specs) {
            if (!spec.fn.isGpu) continue;
            const wgs = spec.fn.workgroupSize ?? [64, 1, 1];
            fb.i32_const(kIdx)
              .i32_const(wgs[0])
              .i32_const(wgs[1])
              .i32_const(wgs[2])
              .call(this.imp.gpu_register_kernel);
            kIdx++;
        }
        fb.call(initIdx);
        const mainKey = this.fnKey("main");
        const idx = this.fnIndex.get(mainKey);
        if (idx === undefined) throw new Error("no main() function found");
        fb.call(idx);
        const mainIdx = this.mod.addFunc(fb);
        // gpu カーネル関数を named export として公開
        let exIdx = 0;
        for (const spec of this.specs) {
            if (!spec.fn.isGpu) continue;
            this.mod.exportFunc(`gpu_kernel_${exIdx}`, spec.index);
            exIdx++;
        }
        return mainIdx;
    }

    // ── 文 ────────────────────────────────────────────────────────────────────

    private emitStmt(node: ASTNode, ctx: FnCtx): void {
        switch (node.type) {
            case "VarDecl": {
                const t = applySubst(node.resolvedType, ctx.subst);
                const wt = this.wtype(t);
                const local = ctx.fb.addLocal(wt);
                ctx.scopes[ctx.scopes.length - 1].set(node.name, { idx: local, wtype: wt });
                this.emitExprAs(node.value, t, ctx);
                ctx.fb.local_set(local);
                break;
            }
            case "Assign": {
                const target = node.target;
                if (target.type === "Identifier") {
                    const v = ctx.lookup(target.name);
                    if (v) { this.emitExprAsW(node.value, v.wtype, ctx); ctx.fb.local_set(v.idx); }
                    else {
                        const g = this.gvar.get(target.name);
                        if (g) { this.emitExprAsW(node.value, g.wtype, ctx); ctx.fb.global_set(g.idx); }
                    }
                    break;
                }
                if (target.type === "MemberAccess") {
                    const recvType = applySubst((target.receiver as any).resolvedType ?? "", ctx.subst);
                    const w = this.isWrapper(recvType);
                    if (w && w.field === target.member && target.receiver.type === "Identifier") {
                        const v = ctx.lookup(target.receiver.name);
                        if (v) { this.emitExprAsW(node.value, v.wtype, ctx); ctx.fb.local_set(v.idx); break; }
                    }
                    // ref フィールドへの代入: addr, value, store
                    const lay = this.getLayout(recvType);
                    const fl = lay.fields.get(target.member)!;
                    this.emitExpr(target.receiver, ctx); // byte addr
                    this.emitExprAs(node.value, fl.mozType, ctx);
                    this.storeField(ctx.fb, fl);
                    break;
                }
                break;
            }
            case "IfStmt": this.emitIf(node, ctx); break;
            case "WhileStmt": this.emitWhile(node, ctx); break;
            case "ForStmt": this.emitFor(node, ctx); break;
            case "ReturnStmt": {
                if (node.value) this.emitExprAs(node.value, ctx.retMoz, ctx);
                ctx.fb.return_();
                break;
            }
            case "BreakStmt": {
                const depth = ctx.breakDepth();
                ctx.fb.br(depth);
                break;
            }
            case "BlockStmt": {
                ctx.pushScope();
                for (const s of node.body) this.emitStmt(s, ctx);
                ctx.popScope();
                break;
            }
            default: {
                // 式文
                const t = this.emitExpr(node, ctx);
                if (t !== VOID) ctx.fb.drop();
                break;
            }
        }
    }

    private emitCond(cond: ASTNode, ctx: FnCtx): void {
        if (cond.type === "Intrinsic" && (cond.name === "__builtin_if" || cond.name === "__builtin_while")) {
            this.emitExpr(cond.args[0], ctx);
            return;
        }
        this.emitExpr(cond, ctx);
    }

    private emitIf(node: any, ctx: FnCtx): void {
        this.emitCond(node.cond, ctx);
        ctx.fb.if_void(); ctx.enter("if");
        ctx.pushScope();
        for (const s of node.body) this.emitStmt(s, ctx);
        ctx.popScope();
        if (node.else) {
            ctx.fb.else_();
            if (node.else.type === "IfStmt") {
                this.emitIf(node.else, ctx);
            } else {
                ctx.pushScope();
                for (const s of node.else.body) this.emitStmt(s, ctx);
                ctx.popScope();
            }
        }
        ctx.fb.end(); ctx.exit();
    }

    private emitWhile(node: any, ctx: FnCtx): void {
        ctx.fb.block_void(); ctx.enter("exit");
        ctx.fb.loop_void(); ctx.enter("cont");
        this.emitCond(node.cond, ctx);
        ctx.fb.emit(OP.i32_eqz).br_if(1); // !cond → break out of loop
        ctx.pushScope();
        for (const s of node.body) this.emitStmt(s, ctx);
        ctx.popScope();
        ctx.fb.br(0); // back-edge
        ctx.fb.end(); ctx.exit(); // loop
        ctx.fb.end(); ctx.exit(); // block
    }

    private emitFor(node: any, ctx: FnCtx): void {
        ctx.pushScope();
        this.emitStmt(node.init, ctx);
        ctx.fb.block_void(); ctx.enter("exit");
        ctx.fb.loop_void(); ctx.enter("cont");
        this.emitCond(node.cond, ctx);
        ctx.fb.emit(OP.i32_eqz).br_if(1);
        ctx.pushScope();
        for (const s of node.body) this.emitStmt(s, ctx);
        ctx.popScope();
        this.emitStmt(node.update, ctx);
        ctx.fb.br(0);
        ctx.fb.end(); ctx.exit();
        ctx.fb.end(); ctx.exit();
        ctx.popScope();
    }

    // ── フィールド load/store ──────────────────────────────────────────────────

    private loadField(fb: FuncBuilder, fl: FieldLayout): void {
        if (fl.wtype === "i64") fb.load(OP.i64_load, 2, fl.offset);
        else fb.load(OP.i32_load, 2, fl.offset);
    }
    private storeField(fb: FuncBuilder, fl: FieldLayout): void {
        if (fl.wtype === "i64") fb.store(OP.i64_store, 2, fl.offset);
        else fb.store(OP.i32_store, 2, fl.offset);
    }

    // ── 式 (型強制つき) ─────────────────────────────────────────────────────────

    // 目標 mozaicScript 型に合わせて値をスタックへ。リテラル幅も解決。
    private emitExprAs(node: ASTNode, targetMoz: string, ctx: FnCtx): void {
        const tm = this.targetMachine(applySubst(targetMoz, ctx.subst));
        if (node.type === "RawLiteral") {
            const is64 = tm === "_m64";
            if (node.kind === "float") {
                if (is64) ctx.fb.i64_const(f64BitsOf(node.value));
                else ctx.fb.i32_const(f32BitsOf(node.value));
            } else {
                if (is64) ctx.fb.i64_const(BigInt(Math.trunc(node.value)));
                else ctx.fb.i32_const(node.value | 0);
            }
            return;
        }
        const w = this.emitExpr(node, ctx);
        const targetW: WType = tm === "_m64" ? "i64" : (tm ? "i32" : this.wtype(applySubst(targetMoz, ctx.subst)));
        this.coerce(ctx.fb, w as WType, targetW, tm);
    }
    private emitExprAsW(node: ASTNode, targetW: WType, ctx: FnCtx): void {
        if (node.type === "RawLiteral") {
            if (targetW === "i64") {
                if (node.kind === "float") ctx.fb.i64_const(f64BitsOf(node.value));
                else ctx.fb.i64_const(BigInt(Math.trunc(node.value)));
            } else {
                if (node.kind === "float") ctx.fb.i32_const(f32BitsOf(node.value));
                else ctx.fb.i32_const(node.value | 0);
            }
            return;
        }
        const w = this.emitExpr(node, ctx) as WType;
        this.coerce(ctx.fb, w, targetW, null);
    }
    private coerce(fb: FuncBuilder, from: WType, to: WType, tm: string | null): void {
        if (from === to) {
            if (tm === "_m8") fb.i32_const(0xff).emit(OP.i32_and);
            else if (tm === "_m16") fb.i32_const(0xffff).emit(OP.i32_and);
            return;
        }
        if (from === "i32" && to === "i64") fb.emit(OP.i64_extend_i32_s);
        else if (from === "i64" && to === "i32") fb.emit(OP.i32_wrap_i64);
    }

    // 値を1つスタックへ。戻り値は WASM 型 or 'void'。
    private emitExpr(node: ASTNode, ctx: FnCtx): EType {
        switch (node.type) {
            case "RawLiteral":
                if (node.kind === "float") { ctx.fb.i32_const(f32BitsOf(node.value)); return "i32"; }
                ctx.fb.i32_const(node.value | 0); return "i32";

            case "Identifier": {
                if (node.name === "this") { ctx.fb.local_get(0); return ctx.lookup("this")!.wtype; }
                const v = ctx.lookup(node.name);
                if (v) { ctx.fb.local_get(v.idx); return v.wtype; }
                const g = this.gvar.get(node.name);
                if (g) { ctx.fb.global_get(g.idx); return g.wtype; }
                ctx.fb.i32_const(0); return "i32"; // 未解決（通常到達しない）
            }

            case "MemberAccess": {
                const recvType = applySubst((node.receiver as any).resolvedType ?? "", ctx.subst);
                const rr = this.resolveAlias(recvType);
                if (MACHINE.has(rr)) return this.emitExpr(node.receiver, ctx); // 機械型に .bits → 値そのもの
                const w = this.isWrapper(rr);
                if (w && w.field === node.member) return this.emitExpr(node.receiver, ctx);
                // ref オブジェクトのフィールド
                this.emitExpr(node.receiver, ctx); // byte addr
                const lay = this.getLayout(rr);
                const fl = lay.fields.get(node.member);
                if (!fl) { ctx.fb.drop(); ctx.fb.i32_const(0); return "i32"; }
                this.loadField(ctx.fb, fl);
                return fl.wtype;
            }

            case "NewExpr": return this.emitNewExpr(node as any, ctx);
            case "MethodCall": return this.emitMethodCall(node as any, ctx);
            case "Intrinsic": return this.emitIntrinsic(node as any, ctx);
            case "BorrowExpr":
                // ゼロコスト借用: WASM 値スタック上はそのまま
                return this.emitExpr((node as any).expr, ctx);
            default: ctx.fb.i32_const(0); return "i32";
        }
    }

    // ── NewExpr ────────────────────────────────────────────────────────────────

    private emitNewExpr(node: any, ctx: FnCtx): EType {
        const concreteType = this.resolveAlias(applySubst(node.resolvedType, ctx.subst));

        // 配列/文字列リテラル
        if (node.elements !== undefined) return this.emitArrayLiteral(node, concreteType, ctx);

        // 機械型
        if (MACHINE.has(concreteType)) {
            if (node.args.length === 0) { if (concreteType === "_m64") { ctx.fb.i64_const(0); return "i64"; } ctx.fb.i32_const(0); return "i32"; }
            return this.emitExprPlain(node.args[0], ctx, concreteType);
        }

        // ラッパー → 裸の値
        const w = this.isWrapper(concreteType);
        if (w) {
            if (node.args.length === 0) { if (w.bits === "_m64") { ctx.fb.i64_const(0); return "i64"; } ctx.fb.i32_const(0); return "i32"; }
            this.emitExprAs(node.args[0], w.bits, ctx);
            return w.bits === "_m64" ? "i64" : "i32";
        }

        // ref オブジェクト: alloc + constructor
        const lay = this.getLayout(concreteType);
        const obj = ctx.fb.addLocal("i32");
        ctx.fb.i32_const(lay.size).call(this.allocIdx).local_set(obj);
        const cls = this.classes.get(baseType(concreteType));
        const ctor = cls?.methods.find(m => m.name === "constructor");
        // 引数を取らない constructor でも本体に副作用 (intrinsic 呼び出し) があり得るので必ず呼ぶ
        if (ctor) {
            const subst = new Map<string, string>();
            const args = typeArgs(concreteType);
            cls!.typeParams.forEach((p, i) => subst.set(p, args[i] ?? p));
            ctx.fb.local_get(obj); // self
            for (let i = 0; i < ctor.params.length; i++) {
                const pt = applySubst(ctor.params[i].resolvedType, subst);
                if (i < node.args.length) this.emitExprAs(node.args[i], pt, ctx);
                else this.emitZero(ctx.fb, this.wtype(pt));
            }
            ctx.fb.call(this.fnIndex.get(this.methodKey(concreteType, "constructor"))!);
        }
        ctx.fb.local_get(obj);
        return "i32";
    }

    private emitExprPlain(node: ASTNode, ctx: FnCtx, targetMachine: string): EType {
        // 機械型コンストラクタ引数（リテラル幅対応）
        if (node.type === "RawLiteral") {
            if (targetMachine === "_m64") {
                if (node.kind === "float") ctx.fb.i64_const(f64BitsOf(node.value));
                else ctx.fb.i64_const(BigInt(Math.trunc(node.value)));
                return "i64";
            }
            if (node.kind === "float") ctx.fb.i32_const(f32BitsOf(node.value));
            else ctx.fb.i32_const(node.value | 0);
            return "i32";
        }
        return this.emitExpr(node, ctx);
    }

    private emitArrayLiteral(node: any, concreteType: string, ctx: FnCtx): EType {
        const elems: any[] = node.elements ?? [];
        const lay = this.getLayout(concreteType);
        const { ptr: ptrName, length: lenName } = this.arrayFields();
        const ptrFl = lay.fields.get(ptrName)!;
        const lenFl = lay.fields.get(lenName)!;
        const obj = ctx.fb.addLocal("i32");
        ctx.fb.i32_const(lay.size).call(this.allocIdx).local_set(obj);
        if (elems.length > 0) {
            const data = ctx.fb.addLocal("i32"); // word index
            ctx.fb.i32_const(elems.length * 4).call(this.mallocIdx).local_set(data);
            // ptr field = data
            ctx.fb.local_get(obj).local_get(data); this.storeField(ctx.fb, ptrFl);
            // base byte addr = data*4
            const base = ctx.fb.addLocal("i32");
            ctx.fb.local_get(data).i32_const(2).emit(OP.i32_shl).local_set(base);
            for (let i = 0; i < elems.length; i++) {
                ctx.fb.local_get(base);
                ctx.fb.i32_const((elems[i].value | 0));
                ctx.fb.store(OP.i32_store, 2, i * 4);
            }
        } else {
            ctx.fb.local_get(obj).i32_const(0); this.storeField(ctx.fb, ptrFl);
        }
        // length field
        ctx.fb.local_get(obj);
        if (lenFl.wtype === "i64") ctx.fb.i64_const(BigInt(elems.length)); else ctx.fb.i32_const(elems.length);
        this.storeField(ctx.fb, lenFl);
        ctx.fb.local_get(obj);
        return "i32";
    }

    private emitZero(fb: FuncBuilder, w: WType): void { if (w === "i64") fb.i64_const(0); else fb.i32_const(0); }

    // ── MethodCall ──────────────────────────────────────────────────────────────

    private lookupMethodReturnType(recvType: string, method: string): string {
        const base = baseType(recvType);
        const cls = this.classes.get(base);
        if (!cls) return "void";
        const m = cls.methods.find(mm => mm.name === method);
        if (!m) return "void";
        const subst = new Map<string, string>();
        const args = typeArgs(recvType);
        cls.typeParams.forEach((tp, i) => { if (args[i]) subst.set(tp, args[i]); });
        return applySubst(m.returnType, subst);
    }

    private emitMethodCall(node: any, ctx: FnCtx): EType {
        const recvType = this.resolveAlias(applySubst((node.receiver as any).resolvedType ?? "void", ctx.subst));

        // _m32/_m64.getBits() は恒等
        if ((recvType === "_m32" || recvType === "_m64") && node.method === "getBits") {
            return this.emitExpr(node.receiver, ctx);
        }

        // free 関数呼び出し
        if (node.receiver.type === "Identifier") {
            const rname = node.receiver.name as string;
            const simple = rname.includes(".") ? rname.slice(rname.lastIndexOf(".") + 1) : rname;
            const fn = this.functions.get(simple);
            if (fn) {
                let concreteT: string | undefined;
                const subst = new Map<string, string>();
                if (fn.typeParams.length > 0) {
                    concreteT = applySubst((node.receiver as any).resolvedType ?? "", ctx.subst) || undefined;
                    if (concreteT) fn.typeParams.forEach(p => subst.set(p, concreteT!));
                }
                for (let i = 0; i < fn.params.length; i++) {
                    const pt = applySubst(fn.params[i].resolvedType, subst);
                    if (i < node.args.length) this.emitExprAs(node.args[i], pt, ctx);
                    else this.emitZero(ctx.fb, this.wtype(pt));
                }
                ctx.fb.call(this.fnIndex.get(this.fnKey(simple, concreteT))!);
                const ret = applySubst(fn.returnType, subst);
                return this.resolveAlias(ret) === "void" ? VOID : this.wtype(ret);
            }
        }

        // メソッド呼び出し（ラッパー or ref）
        this.emitExpr(node.receiver, ctx); // self (bare value or byte addr)
        // メソッドのパラメータ型を取得
        const base = baseType(recvType);
        const cls = this.classes.get(base);
        const method = cls?.methods.find(m => m.name === node.method);
        const subst = new Map<string, string>();
        const targs = typeArgs(recvType);
        cls?.typeParams.forEach((p, i) => subst.set(p, targs[i] ?? p));
        if (method) {
            for (let i = 0; i < method.params.length; i++) {
                const pt = applySubst(method.params[i].resolvedType, subst);
                if (i < node.args.length) this.emitExprAs(node.args[i], pt, ctx);
                else this.emitZero(ctx.fb, this.wtype(pt));
            }
        } else {
            for (const a of node.args) this.emitExpr(a, ctx);
        }
        const fidx = this.fnIndex.get(this.methodKey(recvType, node.method));
        if (fidx === undefined) {
            // 解決不能: 引数/レシーバを捨てて 0
            return VOID;
        }
        ctx.fb.call(fidx);
        let ret = applySubst(node.resolvedType, ctx.subst);
        if (this.resolveAlias(ret) === "void") ret = this.lookupMethodReturnType(recvType, node.method);
        return this.resolveAlias(ret) === "void" ? VOID : this.wtype(ret);
    }

    // ── Intrinsic ────────────────────────────────────────────────────────────────

    private emitIntrinsic(node: any, ctx: FnCtx): EType {
        const fb = ctx.fb;
        const name: string = node.name;
        const a0 = () => this.emitExpr(node.args[0], ctx);
        const a1 = () => this.emitExpr(node.args[1], ctx);
        const a2 = () => this.emitExpr(node.args[2], ctx);

        // 二項 i32/i64 算術: a, b, op
        const bin = (op: number, w: WType): EType => { a0(); a1(); fb.emit(op); return w; };
        // f32 二項算術 (ビット入出力)
        const f32bin = (op: number): EType => {
            a0(); fb.emit(OP.f32_reinterpret_i32);
            a1(); fb.emit(OP.f32_reinterpret_i32);
            fb.emit(op); fb.emit(OP.i32_reinterpret_f32); return "i32";
        };
        const f32cmp = (op: number): EType => {
            a0(); fb.emit(OP.f32_reinterpret_i32);
            a1(); fb.emit(OP.f32_reinterpret_i32);
            fb.emit(op); return "i32";
        };
        const f32un = (op: number): EType => { a0(); fb.emit(OP.f32_reinterpret_i32); fb.emit(op); fb.emit(OP.i32_reinterpret_f32); return "i32"; };
        const f64bin = (op: number): EType => {
            a0(); fb.emit(OP.f64_reinterpret_i64);
            a1(); fb.emit(OP.f64_reinterpret_i64);
            fb.emit(op); fb.emit(OP.i64_reinterpret_f64); return "i64";
        };
        const f64cmp = (op: number): EType => {
            a0(); fb.emit(OP.f64_reinterpret_i64);
            a1(); fb.emit(OP.f64_reinterpret_i64);
            fb.emit(op); return "i32";
        };
        const f64un = (op: number): EType => { a0(); fb.emit(OP.f64_reinterpret_i64); fb.emit(op); fb.emit(OP.i64_reinterpret_f64); return "i64"; };
        // ホスト超越関数 (f32: bits→f32→f64→host→f32→bits)
        const f32host1 = (impName: string): EType => {
            a0(); fb.emit(OP.f32_reinterpret_i32); fb.emit(OP.f64_promote_f32);
            fb.call(this.imp[impName]); fb.emit(OP.f32_demote_f64); fb.emit(OP.i32_reinterpret_f32); return "i32";
        };
        const f32host2 = (impName: string): EType => {
            a0(); fb.emit(OP.f32_reinterpret_i32); fb.emit(OP.f64_promote_f32);
            a1(); fb.emit(OP.f32_reinterpret_i32); fb.emit(OP.f64_promote_f32);
            fb.call(this.imp[impName]); fb.emit(OP.f32_demote_f64); fb.emit(OP.i32_reinterpret_f32); return "i32";
        };
        const f64host1 = (impName: string): EType => {
            a0(); fb.emit(OP.f64_reinterpret_i64); fb.call(this.imp[impName]); fb.emit(OP.i64_reinterpret_f64); return "i64";
        };
        const f64host2 = (impName: string): EType => {
            a0(); fb.emit(OP.f64_reinterpret_i64); a1(); fb.emit(OP.f64_reinterpret_i64);
            fb.call(this.imp[impName]); fb.emit(OP.i64_reinterpret_f64); return "i64";
        };
        const truncSat = (code: number) => fb.raw(0xfc, code);

        switch (name) {
            // i32
            case "__builtin_i32_add": return bin(OP.i32_add, "i32");
            case "__builtin_i32_sub": return bin(OP.i32_sub, "i32");
            case "__builtin_i32_mul": return bin(OP.i32_mul, "i32");
            case "__builtin_i32_div": return bin(OP.i32_div_s, "i32");
            case "__builtin_i32_mod": return bin(OP.i32_rem_s, "i32");
            case "__builtin_i32_neg": fb.i32_const(0); a0(); fb.emit(OP.i32_sub); return "i32";
            case "__builtin_i32_eq": return bin(OP.i32_eq, "i32");
            case "__builtin_i32_lt": return bin(OP.i32_lt_s, "i32");
            case "__builtin_i32_gt": return bin(OP.i32_gt_s, "i32");
            case "__builtin_i32_or": return bin(OP.i32_or, "i32");
            case "__builtin_i32_and": return bin(OP.i32_and, "i32");
            case "__builtin_i32_not": a0(); fb.emit(OP.i32_eqz); return "i32";
            case "__builtin_i32_bitwise_and": return bin(OP.i32_and, "i32");
            case "__builtin_i32_bitwise_or": return bin(OP.i32_or, "i32");
            case "__builtin_i32_bitwise_xor": return bin(OP.i32_xor, "i32");
            case "__builtin_i32_shift_left": return bin(OP.i32_shl, "i32");
            case "__builtin_i32_shift_right": return bin(OP.i32_shr_s, "i32");
            case "__builtin_i32_shl": return bin(OP.i32_shl, "i32");
            case "__builtin_i32_shr": return bin(OP.i32_shr_s, "i32");
            case "__builtin_i32_rotl": return bin(OP.i32_rotl, "i32");
            case "__builtin_i32_rotr": return bin(OP.i32_rotr, "i32");
            case "__builtin_i32_clz": a0(); fb.emit(OP.i32_clz); return "i32";
            case "__builtin_i32_ctz": a0(); fb.emit(OP.i32_ctz); return "i32";
            case "__builtin_i32_popcnt": a0(); fb.emit(OP.i32_popcnt); return "i32";

            // u32
            case "__builtin_u32_add": return bin(OP.i32_add, "i32");
            case "__builtin_u32_sub": return bin(OP.i32_sub, "i32");
            case "__builtin_u32_mul": return bin(OP.i32_mul, "i32");
            case "__builtin_u32_div": return bin(OP.i32_div_u, "i32");
            case "__builtin_u32_mod": return bin(OP.i32_rem_u, "i32");
            case "__builtin_u32_eq": return bin(OP.i32_eq, "i32");
            case "__builtin_u32_lt": return bin(OP.i32_lt_u, "i32");
            case "__builtin_u32_gt": return bin(OP.i32_gt_u, "i32");
            case "__builtin_u32_or": return bin(OP.i32_or, "i32");
            case "__builtin_u32_and": return bin(OP.i32_and, "i32");
            case "__builtin_u32_bitwise_and": return bin(OP.i32_and, "i32");
            case "__builtin_u32_bitwise_or": return bin(OP.i32_or, "i32");
            case "__builtin_u32_bitwise_xor": return bin(OP.i32_xor, "i32");
            case "__builtin_u32_shift_left": return bin(OP.i32_shl, "i32");
            case "__builtin_u32_shift_right": return bin(OP.i32_shr_u, "i32");
            case "__builtin_u32_shl": return bin(OP.i32_shl, "i32");
            case "__builtin_u32_shr": return bin(OP.i32_shr_u, "i32");

            // f32
            case "__builtin_f32_add": return f32bin(OP.f32_add);
            case "__builtin_f32_sub": return f32bin(OP.f32_sub);
            case "__builtin_f32_mul": return f32bin(OP.f32_mul);
            case "__builtin_f32_div": return f32bin(OP.f32_div);
            case "__builtin_f32_mod": {
                a0(); fb.emit(OP.f32_reinterpret_i32); fb.emit(OP.f64_promote_f32);
                a1(); fb.emit(OP.f32_reinterpret_i32); fb.emit(OP.f64_promote_f32);
                fb.call(this.imp.fmod); fb.emit(OP.f32_demote_f64); fb.emit(OP.i32_reinterpret_f32); return "i32";
            }
            case "__builtin_f32_neg": return f32un(OP.f32_neg);
            case "__builtin_f32_eq": return f32cmp(OP.f32_eq);
            case "__builtin_f32_lt": return f32cmp(OP.f32_lt);
            case "__builtin_f32_gt": return f32cmp(OP.f32_gt);
            case "__builtin_f32_abs": return f32un(OP.f32_abs);
            case "__builtin_f32_sqrt": return f32un(OP.f32_sqrt);
            case "__builtin_f32_floor": return f32un(OP.f32_floor);
            case "__builtin_f32_ceil": return f32un(OP.f32_ceil);
            case "__builtin_f32_trunc": return f32un(OP.f32_trunc);
            case "__builtin_f32_nearest": return f32un(OP.f32_nearest);
            case "__builtin_f32_min": return f32bin(OP.f32_min);
            case "__builtin_f32_max": return f32bin(OP.f32_max);
            case "__builtin_f32_sin": return f32host1("sin");
            case "__builtin_f32_cos": return f32host1("cos");
            case "__builtin_f32_tan": return f32host1("tan");
            case "__builtin_f32_exp": return f32host1("exp");
            case "__builtin_f32_log": return f32host1("log");
            case "__builtin_f32_atan": return f32host1("atan");
            case "__builtin_f32_pow": return f32host2("pow");
            case "__builtin_f32_atan2": return f32host2("atan2");

            // f64
            case "__builtin_f64_add": return f64bin(OP.f64_add);
            case "__builtin_f64_sub": return f64bin(OP.f64_sub);
            case "__builtin_f64_mul": return f64bin(OP.f64_mul);
            case "__builtin_f64_div": return f64bin(OP.f64_div);
            case "__builtin_f64_mod": {
                a0(); fb.emit(OP.f64_reinterpret_i64); a1(); fb.emit(OP.f64_reinterpret_i64);
                fb.call(this.imp.fmod); fb.emit(OP.i64_reinterpret_f64); return "i64";
            }
            case "__builtin_f64_neg": return f64un(OP.f64_neg);
            case "__builtin_f64_eq": return f64cmp(OP.f64_eq);
            case "__builtin_f64_lt": return f64cmp(OP.f64_lt);
            case "__builtin_f64_gt": return f64cmp(OP.f64_gt);
            case "__builtin_f64_abs": return f64un(OP.f64_abs);
            case "__builtin_f64_sqrt": return f64un(OP.f64_sqrt);
            case "__builtin_f64_floor": return f64un(OP.f64_floor);
            case "__builtin_f64_ceil": return f64un(OP.f64_ceil);
            case "__builtin_f64_trunc": return f64un(OP.f64_trunc);
            case "__builtin_f64_nearest": return f64un(OP.f64_nearest);
            case "__builtin_f64_min": return f64bin(OP.f64_min);
            case "__builtin_f64_max": return f64bin(OP.f64_max);
            case "__builtin_f64_sin": return f64host1("sin");
            case "__builtin_f64_cos": return f64host1("cos");
            case "__builtin_f64_tan": return f64host1("tan");
            case "__builtin_f64_exp": return f64host1("exp");
            case "__builtin_f64_log": return f64host1("log");
            case "__builtin_f64_atan": return f64host1("atan");
            case "__builtin_f64_pow": return f64host2("pow");
            case "__builtin_f64_atan2": return f64host2("atan2");

            // i64
            case "__builtin_i64_add": return bin(OP.i64_add, "i64");
            case "__builtin_i64_sub": return bin(OP.i64_sub, "i64");
            case "__builtin_i64_mul": return bin(OP.i64_mul, "i64");
            case "__builtin_i64_div": return bin(OP.i64_div_s, "i64");
            case "__builtin_i64_mod": return bin(OP.i64_rem_s, "i64");
            case "__builtin_i64_neg": fb.i64_const(0); a0(); fb.emit(OP.i64_sub); return "i64";
            case "__builtin_i64_eq": return bin(OP.i64_eq, "i32");
            case "__builtin_i64_lt": return bin(OP.i64_lt_s, "i32");
            case "__builtin_i64_gt": return bin(OP.i64_gt_s, "i32");
            case "__builtin_i64_or": return bin(OP.i64_or, "i64");
            case "__builtin_i64_and": return bin(OP.i64_and, "i64");
            case "__builtin_i64_not": a0(); fb.emit(OP.i64_eqz); return "i32";
            case "__builtin_i64_shl": return bin(OP.i64_shl, "i64");
            case "__builtin_i64_shr": return bin(OP.i64_shr_s, "i64");
            case "__builtin_i64_rotl": return bin(OP.i64_rotl, "i64");
            case "__builtin_i64_rotr": return bin(OP.i64_rotr, "i64");
            case "__builtin_i64_clz": a0(); fb.emit(OP.i64_clz); return "i64";
            case "__builtin_i64_ctz": a0(); fb.emit(OP.i64_ctz); return "i64";
            case "__builtin_i64_popcnt": a0(); fb.emit(OP.i64_popcnt); return "i64";

            // u64
            case "__builtin_u64_add": return bin(OP.i64_add, "i64");
            case "__builtin_u64_sub": return bin(OP.i64_sub, "i64");
            case "__builtin_u64_mul": return bin(OP.i64_mul, "i64");
            case "__builtin_u64_div": return bin(OP.i64_div_u, "i64");
            case "__builtin_u64_mod": return bin(OP.i64_rem_u, "i64");
            case "__builtin_u64_eq": return bin(OP.i64_eq, "i32");
            case "__builtin_u64_lt": return bin(OP.i64_lt_u, "i32");
            case "__builtin_u64_gt": return bin(OP.i64_gt_u, "i32");
            case "__builtin_u64_or": return bin(OP.i64_or, "i64");
            case "__builtin_u64_and": return bin(OP.i64_and, "i64");
            case "__builtin_u64_not": a0(); fb.emit(OP.i64_eqz); return "i32";
            case "__builtin_u64_shl": return bin(OP.i64_shl, "i64");
            case "__builtin_u64_shr": return bin(OP.i64_shr_u, "i64");

            // 型変換
            case "__builtin_i32_to_f32": a0(); fb.emit(OP.f32_convert_i32_s); fb.emit(OP.i32_reinterpret_f32); return "i32";
            case "__builtin_i32_to_u32": return a0();
            case "__builtin_u32_to_f32": a0(); fb.emit(OP.f32_convert_i32_u); fb.emit(OP.i32_reinterpret_f32); return "i32";
            case "__builtin_u32_to_i32": return a0();
            case "__builtin_f32_to_i32": a0(); fb.emit(OP.f32_reinterpret_i32); truncSat(TRUNC_SAT.i32_f32_s); return "i32";
            case "__builtin_f32_to_u32": a0(); fb.emit(OP.f32_reinterpret_i32); truncSat(TRUNC_SAT.i32_f32_u); return "i32";
            case "__builtin_i32_to_i64": a0(); fb.emit(OP.i64_extend_i32_s); return "i64";
            case "__builtin_u32_to_u64": a0(); fb.emit(OP.i64_extend_i32_u); return "i64";
            case "__builtin_i32_to_f64": a0(); fb.emit(OP.f64_convert_i32_s); fb.emit(OP.i64_reinterpret_f64); return "i64";
            case "__builtin_u32_to_f64": a0(); fb.emit(OP.f64_convert_i32_u); fb.emit(OP.i64_reinterpret_f64); return "i64";
            case "__builtin_i64_to_i32": a0(); fb.emit(OP.i32_wrap_i64); return "i32";
            case "__builtin_u64_to_u32": a0(); fb.emit(OP.i32_wrap_i64); return "i32";
            case "__builtin_f32_to_f64": a0(); fb.emit(OP.f32_reinterpret_i32); fb.emit(OP.f64_promote_f32); fb.emit(OP.i64_reinterpret_f64); return "i64";
            case "__builtin_f64_to_f32": a0(); fb.emit(OP.f64_reinterpret_i64); fb.emit(OP.f32_demote_f64); fb.emit(OP.i32_reinterpret_f32); return "i32";
            case "__builtin_f64_to_i64": a0(); fb.emit(OP.f64_reinterpret_i64); truncSat(TRUNC_SAT.i64_f64_s); return "i64";
            case "__builtin_i64_to_f64": a0(); fb.emit(OP.f64_convert_i64_s); fb.emit(OP.i64_reinterpret_f64); return "i64";
            case "__builtin_u64_to_f64": a0(); fb.emit(OP.f64_convert_i64_u); fb.emit(OP.i64_reinterpret_f64); return "i64";

            // メモリ
            case "__builtin_malloc": a0(); fb.call(this.mallocIdx); return "i32";
            case "__builtin_ptr_alloc": a0(); fb.call(this.mallocIdx); return "i32";
            case "__builtin_free": { a0(); fb.drop(); return VOID; }
            case "__builtin_ptr_free": { a0(); fb.drop(); return VOID; }
            case "__builtin_zeroinit": fb.i32_const(0); return "i32";
            case "__builtin_mem_read32": this.memAddr(ctx, node); fb.load(OP.i32_load, 2, 0); return "i32";
            case "__builtin_mem_read8": this.memAddr(ctx, node); fb.load(OP.i32_load8_u, 0, 0); return "i32";
            case "__builtin_mem_read16": this.memAddr(ctx, node); fb.load(OP.i32_load16_u, 1, 0); return "i32";
            case "__builtin_mem_read64": this.memAddr(ctx, node); fb.load(OP.i64_load, 2, 0); return "i64";
            case "__builtin_mem_write32": { this.memAddr(ctx, node); this.emitExprAsW(node.args[2], "i32", ctx); fb.store(OP.i32_store, 2, 0); return VOID; }
            case "__builtin_mem_write8": { this.memAddr(ctx, node); this.emitExprAsW(node.args[2], "i32", ctx); fb.store(OP.i32_store8, 0, 0); return VOID; }
            case "__builtin_mem_write16": { this.memAddr(ctx, node); this.emitExprAsW(node.args[2], "i32", ctx); fb.store(OP.i32_store16, 1, 0); return VOID; }
            case "__builtin_mem_write64": { this.memAddr(ctx, node); this.emitExprAsW(node.args[2], "i64", ctx); fb.store(OP.i64_store, 2, 0); return VOID; }
            case "__builtin_ptr_read": { a0(); fb.i32_const(2).emit(OP.i32_shl); fb.load(OP.i32_load, 2, 0); return "i32"; }
            case "__builtin_ptr_write": { a0(); fb.i32_const(2).emit(OP.i32_shl); this.emitExprAsW(node.args[1], "i32", ctx); fb.store(OP.i32_store, 2, 0); return VOID; }

            // I/O
            case "__builtin_stdout_write": return this.emitWriteStr(ctx, node.args[0], this.imp.stdout);
            case "__builtin_stderr_write": return this.emitWriteStr(ctx, node.args[0], this.imp.stderr);
            case "__builtin_panic": return this.emitWriteStr(ctx, node.args[0], this.imp.panic);
            case "__builtin_stdin_readline": fb.unreachable(); return "i32";

            case "__builtin_sizeof": fb.i32_const(this.computeSizeof(applySubst(node.targetType ?? "i32", ctx.subst))); return "i32";

            // atomic（シングルスレッド: 通常のヒープ操作、order は no-op）
            // 32bit
            case "__builtin_atomic_load32": {
                a0(); fb.i32_const(2).emit(OP.i32_shl); fb.load(OP.i32_load, 2, 0);
                a1(); fb.drop();
                return "i32";
            }
            case "__builtin_atomic_store32": {
                a0(); fb.i32_const(2).emit(OP.i32_shl);
                this.emitExprAsW(node.args[1], "i32", ctx);
                fb.store(OP.i32_store, 2, 0);
                a2(); fb.drop();
                return VOID;
            }
            case "__builtin_atomic_fetch_add32": return this.emitAtomicFetch32(ctx, node, OP.i32_add);
            case "__builtin_atomic_fetch_sub32": return this.emitAtomicFetch32(ctx, node, OP.i32_sub);
            case "__builtin_atomic_cas32": return this.emitAtomicCas32(ctx, node);
            // 64bit（ptr は 2-word アライメント必須）
            case "__builtin_atomic_load64": {
                a0(); fb.i32_const(2).emit(OP.i32_shl); fb.load(OP.i64_load, 2, 0);
                a1(); fb.drop();
                return "i64";
            }
            case "__builtin_atomic_store64": {
                a0(); fb.i32_const(2).emit(OP.i32_shl);
                this.emitExprAsW(node.args[1], "i64", ctx);
                fb.store(OP.i64_store, 2, 0);
                a2(); fb.drop();
                return VOID;
            }
            case "__builtin_atomic_fetch_add64": return this.emitAtomicFetch64(ctx, node, OP.i64_add);
            case "__builtin_atomic_fetch_sub64": return this.emitAtomicFetch64(ctx, node, OP.i64_sub);
            case "__builtin_atomic_cas64": return this.emitAtomicCas64(ctx, node);
            // フェンス — no-op
            case "__builtin_atomic_fence": { a0(); fb.drop(); return VOID; }

            // mutex / condvar: no-op（シングルスレッド）。id は単調増加で発行。
            case "__builtin_mutex_create":
            case "__builtin_condvar_create": this.pushFreshId(fb); return "i64";
            case "__builtin_mutex_lock": case "__builtin_mutex_unlock":
            case "__builtin_condvar_signal": case "__builtin_condvar_broadcast": { a0(); fb.drop(); return VOID; }
            case "__builtin_condvar_wait": { a0(); fb.drop(); a1(); fb.drop(); return VOID; }

            // thread / threadpool: シングルスレッドで同期実行（JS バックエンドと同じ）。
            case "__builtin_thread_spawn": {
                const o = this.strObjLocal(ctx, node.args[0]); // fnName を評価
                a1(); fb.drop();                               // emptyArgs を評価
                this.pushStrPtrLen(ctx, o); fb.call(this.callByNameIdx);
                this.pushFreshId(fb); return "i64";
            }
            case "__builtin_threadpool_submit": {
                a0(); fb.drop();                               // pool を評価
                const o = this.strObjLocal(ctx, node.args[1]); // fnName を評価
                a2(); fb.drop();                               // emptyArgs を評価
                this.pushStrPtrLen(ctx, o); fb.call(this.callByNameIdx);
                return VOID;
            }
            case "__builtin_threadpool_create": { a0(); fb.drop(); this.pushFreshId(fb); return "i64"; }
            case "__builtin_thread_join": { a0(); fb.drop(); return VOID; }
            case "__builtin_threadpool_wait": case "__builtin_threadpool_destroy": { a0(); fb.drop(); return VOID; }

            case "__builtin_mem_set": return this.emitMemSet(ctx, node);

            // ── GPU エミュレーション (env imports へ転送) ─────────────────────
            case "__builtin_gpu_is_available":         fb.call(this.imp.gpu_is_available); return "i32";
            case "__builtin_gpu_buffer_create":        a0(); fb.call(this.imp.gpu_buf_create); return "i64";
            case "__builtin_gpu_buffer_map_write":     a0(); fb.call(this.imp.gpu_buf_map_write); return "i32";
            case "__builtin_gpu_buffer_map_read":      a0(); fb.call(this.imp.gpu_buf_map_read); return "i32";
            case "__builtin_gpu_buffer_unmap":         a0(); fb.call(this.imp.gpu_buf_unmap); return VOID;
            case "__builtin_gpu_buffer_byte_size":     a0(); fb.call(this.imp.gpu_buf_byte_size); return "i64";
            case "__builtin_gpu_buffer_free":          a0(); fb.call(this.imp.gpu_buf_free); return VOID;
            case "__builtin_gpu_kernel_handle":        a0(); fb.call(this.imp.gpu_kern_handle); return "i64";
            case "__builtin_gpu_kernel_workgroup_size_x": a0(); fb.call(this.imp.gpu_kern_wgx); return "i32";
            case "__builtin_gpu_kernel_workgroup_size_y": a0(); fb.call(this.imp.gpu_kern_wgy); return "i32";
            case "__builtin_gpu_kernel_workgroup_size_z": a0(); fb.call(this.imp.gpu_kern_wgz); return "i32";
            case "__builtin_gpu_args_create":          fb.call(this.imp.gpu_args_create); return "i64";
            case "__builtin_gpu_args_push_buffer":     a0(); a1(); fb.call(this.imp.gpu_args_push_buf); return VOID;
            case "__builtin_gpu_args_push_i32":        a0(); a1(); fb.call(this.imp.gpu_args_push_i32); return VOID;
            case "__builtin_gpu_args_push_u32":        a0(); a1(); fb.call(this.imp.gpu_args_push_i32); return VOID;
            case "__builtin_gpu_args_push_i64":        a0(); a1(); fb.call(this.imp.gpu_args_push_i64); return VOID;
            case "__builtin_gpu_args_push_u64":        a0(); a1(); fb.call(this.imp.gpu_args_push_i64); return VOID;
            case "__builtin_gpu_args_push_f32":        a0(); a1(); fb.call(this.imp.gpu_args_push_i32); return VOID;
            case "__builtin_gpu_args_push_f64":        a0(); a1(); fb.call(this.imp.gpu_args_push_i64); return VOID;
            case "__builtin_gpu_args_push_boolean":    a0(); a1(); fb.call(this.imp.gpu_args_push_i32); return VOID;
            case "__builtin_gpu_args_count":           a0(); fb.call(this.imp.gpu_args_count); return "i32";
            case "__builtin_gpu_args_clear":           a0(); fb.call(this.imp.gpu_args_clear); return VOID;
            case "__builtin_gpu_dispatch":
                a0(); a1(); a2();
                this.emitExpr(node.args[3], ctx);
                this.emitExpr(node.args[4], ctx);
                fb.call(this.imp.gpu_dispatch); return VOID;
            case "__builtin_gpu_sync":                 fb.call(this.imp.gpu_sync); return VOID;
            case "__builtin_gpu_flush":                fb.call(this.imp.gpu_flush); return VOID;
            case "__builtin_gpu_thread_global_id_x":   fb.call(this.imp.gpu_tid_gix); return "i32";
            case "__builtin_gpu_thread_global_id_y":   fb.call(this.imp.gpu_tid_giy); return "i32";
            case "__builtin_gpu_thread_global_id_z":   fb.call(this.imp.gpu_tid_giz); return "i32";
            case "__builtin_gpu_thread_local_id_x":    fb.call(this.imp.gpu_tid_lix); return "i32";
            case "__builtin_gpu_thread_local_id_y":    fb.call(this.imp.gpu_tid_liy); return "i32";
            case "__builtin_gpu_thread_local_id_z":    fb.call(this.imp.gpu_tid_liz); return "i32";
            case "__builtin_gpu_thread_workgroup_id_x":fb.call(this.imp.gpu_tid_wix); return "i32";
            case "__builtin_gpu_thread_workgroup_id_y":fb.call(this.imp.gpu_tid_wiy); return "i32";
            case "__builtin_gpu_thread_workgroup_id_z":fb.call(this.imp.gpu_tid_wiz); return "i32";
            case "__builtin_gpu_thread_workgroup_size":fb.call(this.imp.gpu_tid_wgx); return "i32";
            case "__builtin_gpu_barrier":              return VOID;
            case "__builtin_gpu_storage_barrier":      return VOID;
            case "__builtin_gpu_atomic_add_u32":       a0(); a1(); fb.call(this.imp.gpu_atomic_add_u32); return "i32";
            case "__builtin_gpu_atomic_sub_u32":       a0(); a1(); fb.call(this.imp.gpu_atomic_sub_u32); return "i32";
            case "__builtin_gpu_atomic_min_u32":       a0(); a1(); fb.call(this.imp.gpu_atomic_min_u32); return "i32";
            case "__builtin_gpu_atomic_max_u32":       a0(); a1(); fb.call(this.imp.gpu_atomic_max_u32); return "i32";
            case "__builtin_gpu_atomic_cas_u32":       a0(); a1(); a2(); fb.call(this.imp.gpu_atomic_cas_u32); return "i32";
            case "__builtin_gpu_atomic_load_u32":      a0(); fb.call(this.imp.gpu_atomic_load_u32); return "i32";
            case "__builtin_gpu_atomic_store_u32":     a0(); a1(); fb.call(this.imp.gpu_atomic_store_u32); return VOID;
            case "__builtin_gpu_atomic_add_i32":       a0(); a1(); fb.call(this.imp.gpu_atomic_add_i32); return "i32";
            case "__builtin_gpu_atomic_sub_i32":       a0(); a1(); fb.call(this.imp.gpu_atomic_sub_i32); return "i32";
            case "__builtin_gpu_atomic_min_i32":       a0(); a1(); fb.call(this.imp.gpu_atomic_min_i32); return "i32";
            case "__builtin_gpu_atomic_max_i32":       a0(); a1(); fb.call(this.imp.gpu_atomic_max_i32); return "i32";
            case "__builtin_gpu_atomic_cas_i32":       a0(); a1(); a2(); fb.call(this.imp.gpu_atomic_cas_i32); return "i32";
            case "__builtin_gpu_atomic_load_i32":      a0(); fb.call(this.imp.gpu_atomic_load_i32); return "i32";
            case "__builtin_gpu_atomic_store_i32":     a0(); a1(); fb.call(this.imp.gpu_atomic_store_i32); return VOID;
            case "__builtin_gpu_fma":                  a0(); a1(); a2(); fb.call(this.imp.gpu_fma); return "i32";
            case "__builtin_gpu_dot_f32x4":            a0(); a1(); fb.call(this.imp.gpu_dot_f32x4); return "i32";
            case "__builtin_gpu_kernel_name":          a0(); fb.call(this.imp.gpu_kernel_name); return "i32";

            default: fb.i32_const(0); return "i32";
        }
    }

    // mem builtin のバイトアドレス = ptr*4 + off をスタックへ
    private memAddr(ctx: FnCtx, node: any): void {
        this.emitExpr(node.args[0], ctx);              // ptr (word index)
        ctx.fb.i32_const(2).emit(OP.i32_shl);          // *4
        this.emitExpr(node.args[1], ctx);              // off (bytes)
        ctx.fb.emit(OP.i32_add);
    }

    // 文字列 Array オブジェクトをローカルへ評価し、ptr/len フィールドのレイアウトを返す
    private strObjLocal(ctx: FnCtx, arg: ASTNode): { s: number; ptrFl: FieldLayout; lenFl: FieldLayout } {
        const at = this.resolveAlias(applySubst((arg as any).resolvedType ?? "Array<u32>", ctx.subst));
        const lay = this.getLayout(at);
        const { ptr: ptrName, length: lenName } = this.arrayFields();
        const s = ctx.fb.addLocal("i32");
        this.emitExpr(arg, ctx); ctx.fb.local_set(s); // obj byte addr
        return { s, ptrFl: lay.fields.get(ptrName)!, lenFl: lay.fields.get(lenName)! };
    }
    private pushStrPtrLen(ctx: FnCtx, o: { s: number; ptrFl: FieldLayout; lenFl: FieldLayout }): void {
        ctx.fb.local_get(o.s); this.loadField(ctx.fb, o.ptrFl); // ptr word index
        ctx.fb.local_get(o.s); this.loadField(ctx.fb, o.lenFl); // length
    }
    private emitWriteStr(ctx: FnCtx, arg: ASTNode, impIdx: number): EType {
        const o = this.strObjLocal(ctx, arg);
        this.pushStrPtrLen(ctx, o);
        ctx.fb.call(impIdx);
        return VOID;
    }
    // 新しい同期 ID を発行し i64 でスタックへ
    private pushFreshId(fb: FuncBuilder): void {
        fb.global_get(this.syncNextGlobal);
        fb.global_get(this.syncNextGlobal).i32_const(1).emit(OP.i32_add).global_set(this.syncNextGlobal);
        fb.emit(OP.i64_extend_i32_u);
    }

    // MemoryOrder 対応版（order は評価して drop するだけ）
    private emitAtomicFetch32(ctx: FnCtx, node: any, op: number): EType {
        const fb = ctx.fb;
        const addr = fb.addLocal("i32");
        const old = fb.addLocal("i32");
        this.emitExpr(node.args[0], ctx); fb.i32_const(2).emit(OP.i32_shl); fb.local_set(addr);
        this.emitExprAsW(node.args[2], "i32", ctx); fb.drop(); // order
        fb.local_get(addr); fb.load(OP.i32_load, 2, 0); fb.local_set(old);
        fb.local_get(addr);
        fb.local_get(old); this.emitExprAsW(node.args[1], "i32", ctx); fb.emit(op);
        fb.store(OP.i32_store, 2, 0);
        fb.local_get(old);
        return "i32";
    }

    private emitAtomicCas32(ctx: FnCtx, node: any): EType {
        const fb = ctx.fb;
        const addr = fb.addLocal("i32");
        this.emitExpr(node.args[0], ctx); fb.i32_const(2).emit(OP.i32_shl); fb.local_set(addr);
        this.emitExprAsW(node.args[3], "i32", ctx); fb.drop(); // successOrder
        this.emitExprAsW(node.args[4], "i32", ctx); fb.drop(); // failureOrder
        fb.local_get(addr); fb.load(OP.i32_load, 2, 0);
        this.emitExprAsW(node.args[1], "i32", ctx);
        fb.emit(OP.i32_eq);
        fb.if_t("i32");
        fb.local_get(addr); this.emitExprAsW(node.args[2], "i32", ctx); fb.store(OP.i32_store, 2, 0);
        fb.i32_const(1);
        fb.else_();
        fb.i32_const(0);
        fb.end();
        return "i32";
    }

    private emitAtomicFetch64(ctx: FnCtx, node: any, op: number): EType {
        const fb = ctx.fb;
        const addr = fb.addLocal("i32");
        const old = fb.addLocal("i64");
        this.emitExpr(node.args[0], ctx); fb.i32_const(2).emit(OP.i32_shl); fb.local_set(addr);
        this.emitExprAsW(node.args[2], "i32", ctx); fb.drop(); // order
        fb.local_get(addr); fb.load(OP.i64_load, 2, 0); fb.local_set(old);
        fb.local_get(addr);
        fb.local_get(old); this.emitExprAsW(node.args[1], "i64", ctx); fb.emit(op);
        fb.store(OP.i64_store, 2, 0);
        fb.local_get(old);
        return "i64";
    }

    private emitAtomicCas64(ctx: FnCtx, node: any): EType {
        const fb = ctx.fb;
        const addr = fb.addLocal("i32");
        this.emitExpr(node.args[0], ctx); fb.i32_const(2).emit(OP.i32_shl); fb.local_set(addr);
        this.emitExprAsW(node.args[3], "i32", ctx); fb.drop(); // successOrder
        this.emitExprAsW(node.args[4], "i32", ctx); fb.drop(); // failureOrder
        fb.local_get(addr); fb.load(OP.i64_load, 2, 0);
        this.emitExprAsW(node.args[1], "i64", ctx);
        fb.emit(OP.i64_eq);
        fb.if_t("i32");
        fb.local_get(addr); this.emitExprAsW(node.args[2], "i64", ctx); fb.store(OP.i64_store, 2, 0);
        fb.i32_const(1);
        fb.else_();
        fb.i32_const(0);
        fb.end();
        return "i32";
    }

    private emitMemSet(ctx: FnCtx, node: any): EType {
        // __builtin_mem_set(ptr, val, count): heap[ptr+i]=val for i in 0..count （ワード単位）
        const fb = ctx.fb;
        const base = fb.addLocal("i32"); // byte base
        const val = fb.addLocal("i32");
        const cnt = fb.addLocal("i32");
        const i = fb.addLocal("i32");
        this.emitExpr(node.args[0], ctx); fb.i32_const(2).emit(OP.i32_shl); fb.local_set(base);
        this.emitExprAsW(node.args[1], "i32", ctx); fb.local_set(val);
        this.emitExprAsW(node.args[2], "i32", ctx); fb.local_set(cnt);
        fb.i32_const(0).local_set(i);
        fb.block_void(); fb.loop_void();
        fb.local_get(i).local_get(cnt).emit(OP.i32_ge_s).br_if(1);
        fb.local_get(base).local_get(i).i32_const(2).emit(OP.i32_shl).emit(OP.i32_add);
        fb.local_get(val);
        fb.store(OP.i32_store, 2, 0);
        fb.local_get(i).i32_const(1).emit(OP.i32_add).local_set(i);
        fb.br(0);
        fb.end(); fb.end();
        return VOID;
    }
}

// ── 関数発行コンテキスト ─────────────────────────────────────────────────────

class FnCtx {
    scopes: Map<string, { idx: number; wtype: WType }>[] = [new Map()];
    // 制御フレーム（break のための相対深さ計算用）
    private labels: string[] = [];

    constructor(public fb: FuncBuilder, public subst: Map<string, string>, public selfType: string | undefined, public retMoz: string) {}

    pushScope(): void { this.scopes.push(new Map()); }
    popScope(): void { this.scopes.pop(); }
    lookup(name: string): { idx: number; wtype: WType } | undefined {
        for (let i = this.scopes.length - 1; i >= 0; i--) {
            const v = this.scopes[i].get(name);
            if (v) return v;
        }
        return undefined;
    }
    enter(label: string): void { this.labels.push(label); }
    exit(): void { this.labels.pop(); }
    // 最も内側のループ脱出ブロック ('exit') への相対深さ
    breakDepth(): number {
        for (let i = this.labels.length - 1; i >= 0; i--) {
            if (this.labels[i] === "exit") return this.labels.length - 1 - i;
        }
        return 0;
    }
}
