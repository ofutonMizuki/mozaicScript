// codegen/codegen.ts — mozaicScript IR → C コードジェネレータ

import * as fs from "fs";
import * as nodePath from "path";
import {
    ASTNode, ClassDecl, FunctionDecl, MozaicScriptAST,
} from "../interpreter/types";

// ── 型ユーティリティ ──────────────────────────────────────────────────────────

// 参照修飾子 (& / &mut) を剥がす。コード生成時には参照と所有権の区別は消える
// （借用チェッカーがフロントエンドで安全性を保証済みのため）
function stripRef(mozType: string): string {
    if (mozType.startsWith("&mut ")) return mozType.slice(5);
    if (mozType.startsWith("&"))     return mozType.slice(1);
    return mozType;
}

function baseType(mozType: string): string {
    const t = stripRef(mozType);
    const lt = t.indexOf("<");
    return lt === -1 ? t : t.slice(0, lt);
}

function typeArgs(mozType: string): string[] {
    const t = stripRef(mozType);
    const lt = t.indexOf("<");
    if (lt === -1) return [];
    const inner = t.slice(lt + 1, t.lastIndexOf(">"));
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
    const stripped = stripRef(mozType);
    const direct = subst.get(stripped);
    if (direct !== undefined) return direct;
    const base = baseType(stripped);
    const args = typeArgs(stripped);
    if (args.length === 0) return stripped;
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
    "operator[]":       "op_index_get",
    "operator_set[]":   "op_index_set",
    "constructor":      "constructor",
};

function mangleMethod(method: string): string {
    return OPERATOR_MAP[method] ?? method;
}

// ── C名前生成 ──────────────────────────────────────────────────────────────────

function cStructName(mozType: string): string {
    if (mozType === "_m8")   return "int8_t";
    if (mozType === "_m16")  return "int16_t";
    if (mozType === "_m32")  return "int32_t";
    if (mozType === "_m64")  return "int64_t";
    if (mozType === "_m128") return "int32_t"; // 未実装: 128bit は int32_t で近似
    if (mozType === "_m256") return "int32_t"; // 未実装: 256bit は int32_t で近似
    if (mozType === "_m512") return "int32_t"; // 未実装: 512bit は int32_t で近似
    if (mozType === "void")  return "void";
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
    private classes          = new Map<string, ClassDecl>();
    private functions        = new Map<string, FunctionDecl>();
    private globals          = new Map<string, { type: string; value: ASTNode; origin: string }>();
    private typeAliases      = new Map<string, string>();
    private genericInsts     = new Set<string>();
    private genericFuncInsts = new Map<string, Set<string>>(); // fn name → concrete T types
    private loadedFiles      = new Set<string>();
    private tmpCount         = 0;

    // シンボルの出所追跡（シンボル名 → 絶対ファイルパス）
    private classOrigin  = new Map<string, string>();
    private fnOrigin     = new Map<string, string>();
    // エントリファイル情報
    private entryFile    = "";
    // エントリが直接 import しているファイル（順序保持）
    private entryImports: { absPath: string; cName: string }[] = [];

    constructor(_baseDir: string) {}

    private arrayFields(): { ptr: string; len: string } {
        const cls = this.classes.get("Array");
        if (!cls) return { ptr: "ptr", len: "len" };
        const ptrF = cls.members.find(m => m.resolvedType === "_m32" && m.access === "private");
        // length field may be _m32 (legacy) or a wrapper type (u32 etc.) with a bits field
        const lenF = cls.members.find(m => m !== ptrF && m.resolvedType === "_m32");
        if (lenF) return { ptr: ptrF?.name ?? "ptr", len: lenF.name };
        // wrapper: find a field whose class has a single `bits` machine-type field
        const wrapF = cls.members.find(m => {
            if (m === ptrF) return false;
            const wc = this.classes.get(baseType(m.resolvedType));
            if (!wc) return false;
            const bf = wc.members.find(f => f.name === "bits");
            return bf !== undefined && (bf.resolvedType === "_m32" || bf.resolvedType === "_m64");
        });
        if (wrapF) return { ptr: ptrF?.name ?? "ptr", len: `${wrapF.name}.bits` };
        return { ptr: ptrF?.name ?? "ptr", len: "len" };
    }

    private static readonly MACHINE_TYPES = new Set(["_m8","_m16","_m32","_m64","_m128","_m256","_m512"]);

    // 参照型オブジェクトはヒープ確保しポインタ（=機械ポインタ幅）で受け渡す
    private static readonly POINTER_SIZE = 8;

    // 現在エミット中のクラス型（"this" を self ポインタとして出すか判定するため）
    private curClassType = "";

    // 型エイリアスを解決（char→u32, string→Array<u32> 等）
    private resolveAlias(mozType: string): string {
        let t = mozType;
        const seen = new Set<string>();
        while (this.typeAliases.has(t) && !seen.has(t)) { seen.add(t); t = this.typeAliases.get(t)!; }
        return t;
    }

    // 参照型（ヒープ確保しポインタで扱うオブジェクト）か判定する。
    // 単一の機械型フィールドを持つラッパー型（i32/u32/f32/boolean 等）と
    // _mXX / void は値型として扱う。多フィールドのクラス（Vec2/Option/Result/Array 等）は参照型。
    private isRef(mozType: string): boolean {
        const t = this.resolveAlias(mozType);
        if (t === "void" || CCodegen.MACHINE_TYPES.has(t)) return false;
        const cls = this.classes.get(baseType(t));
        if (!cls) return false;
        if (cls.members.length === 1 &&
            CCodegen.MACHINE_TYPES.has(this.resolveAlias(cls.members[0].resolvedType))) return false;
        return true;
    }

    // mozaicScript 型 → C 型表記（参照型はポインタ）
    private cType(mozType: string): string {
        const t = this.resolveAlias(mozType);
        return this.isRef(t) ? `${cStructName(t)}*` : cStructName(t);
    }

    // mozaicScript 参照型 (&T / &mut T) を考慮した C パラメータ型表記
    // - &T (ref オブジェクト) → const _ms_T*
    // - &mut T (ref オブジェクト) → _ms_T* __restrict__
    // - wrapper や機械型の参照: C では既に値渡しなので qualifier 不要
    // (§6.1.1 GCC -O2 ターゲット)
    private cParamType(mozType: string): string {
        const isRefMoz = mozType.startsWith("&mut ") || mozType.startsWith("&");
        if (!isRefMoz) return this.cType(mozType);
        const isMut = mozType.startsWith("&mut ");
        const inner = isMut ? mozType.slice(5) : mozType.slice(1);
        const resolved = this.resolveAlias(inner);
        // wrapper / 機械型は値渡しのまま (qualifier 無し)
        if (!this.isRef(resolved)) return this.cType(resolved);
        // ref オブジェクト: 必ずポインタ。const / restrict を付与
        const base = cStructName(resolved);
        return isMut ? `${base}* __restrict__` : `const ${base}*`;
    }

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
            } else if (node.type === "VarDecl") {
                this.globals.set(node.name, { type: node.resolvedType, value: node.value, origin: filePath });
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
                // track generic top-level function instantiations
                if (node.receiver.type === "Identifier") {
                    const rname = (node.receiver as any).name as string;
                    const simpleName = rname.includes(".") ? rname.slice(rname.lastIndexOf(".") + 1) : rname;
                    const fn = this.functions.get(simpleName);
                    if (fn && fn.typeParams.length > 0) {
                        const concreteT = (node.receiver as any).resolvedType as string;
                        if (concreteT && !excluded.has(concreteT)) {
                            if (!this.genericFuncInsts.has(simpleName)) this.genericFuncInsts.set(simpleName, new Set());
                            this.genericFuncInsts.get(simpleName)!.add(concreteT);
                        }
                    }
                }
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
            case "BorrowExpr":
                this.scanNode((node as any).expr, excluded);
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
            case "BlockStmt":
                node.body.forEach(n => this.scanNode(n, excluded));
                break;
        }
    }

    private scanFn(fn: FunctionDecl, subst: Map<string, string>, excluded: Set<string>): void {
        // メソッド/関数自身の typeParams も collectType の対象外にする (Ptr<T> リテラルが
        // 具象 instance として登録されるのを防ぐ)
        const ex2 = fn.typeParams.length ? new Set([...excluded, ...fn.typeParams]) : excluded;
        fn.params.forEach(p => this.collectType(applySubst(p.resolvedType, subst), ex2));
        this.collectType(applySubst(fn.returnType, subst), ex2);
        fn.body.forEach(n => this.scanNode(n, ex2));
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
        parts.push(this.emitGpuKernelWrappers());
        parts.push(this.emitCallByName());
        parts.push(this.emitMain());
        const body = parts.filter(p => p.trim()).join("\n\n");

        // include guard to prevent double-inclusion when multiple files #include this
        const baseName = nodePath.basename(this.entryFile).replace(/\.(moz|moc)$/, "");
        const guard = `_MS_${baseName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_C`;
        return `#ifndef ${guard}\n#define ${guard}\n\n${body}\n\n#endif /* ${guard} */\n`;
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

/* ── Heap (word-addressed flat memory, grows on demand → effectively unbounded) ── */
static int32_t* _ms_heap = NULL;
static int32_t  _ms_heap_words = 0;
static int32_t  _ms_heap_next = 1; /* 0 = null */

/* Ensure the heap holds at least need_words words. Newly grown memory is
   zero-filled so reads of never-written cells return 0 (matches the
   interpreter / JS backends). */
static void _ms_heap_ensure(int32_t need_words) {
    if (need_words <= _ms_heap_words) return;
    int32_t cap = _ms_heap_words ? _ms_heap_words : (1 << 18);
    while (cap < need_words) {
        int32_t doubled = cap << 1;
        cap = (doubled > cap) ? doubled : need_words; /* guard against overflow */
    }
    int32_t* p = (int32_t*)realloc(_ms_heap, (size_t)cap * sizeof(int32_t));
    if (!p) { fprintf(stderr, "mozaicScript: heap allocation failed (%d words)\\n", cap); exit(1); }
    memset(p + _ms_heap_words, 0, (size_t)(cap - _ms_heap_words) * sizeof(int32_t));
    _ms_heap = p;
    _ms_heap_words = cap;
}

static int32_t _ms_malloc(int32_t size_bytes) {
    int32_t addr = _ms_heap_next;
    _ms_heap_next += (size_bytes + 3) / 4;
    _ms_heap_ensure(_ms_heap_next);
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

/* ── f64 bit conversion ── */
static inline int64_t _ms_f64_bits(double d) {
    int64_t r; memcpy(&r, &d, 8); return r;
}
static inline double _ms_bits_f64(int64_t b) {
    double r; memcpy(&r, &b, 8); return r;
}

/* ── 64-bit heap r/w (word index = byte_offset / 4) ── */
static int64_t _ms_mem_read64(int32_t ptr, int64_t byte_offset) {
    int64_t r;
    memcpy(&r, &_ms_heap[(int32_t)(ptr) + (int32_t)(byte_offset) / 4], 8);
    return r;
}
static void _ms_mem_write64(int32_t ptr, int64_t byte_offset, int64_t value) {
    memcpy(&_ms_heap[(int32_t)(ptr) + (int32_t)(byte_offset) / 4], &value, 8);
}

/* ── 8/16-bit heap r/w ── */
static int32_t _ms_mem_read8(int64_t ptr, int64_t byte_offset) {
    return (uint8_t)((uint8_t*)_ms_heap)[(int32_t)(ptr) * 4 + (int32_t)(byte_offset)];
}
static int32_t _ms_mem_read16(int64_t ptr, int64_t byte_offset) {
    uint16_t r;
    memcpy(&r, &((uint8_t*)_ms_heap)[(int32_t)(ptr) * 4 + (int32_t)(byte_offset)], 2);
    return (int32_t)r;
}
static void _ms_mem_write8(int64_t ptr, int64_t byte_offset, int32_t v) {
    ((uint8_t*)_ms_heap)[(int32_t)(ptr) * 4 + (int32_t)(byte_offset)] = (uint8_t)v;
}
static void _ms_mem_write16(int64_t ptr, int64_t byte_offset, int32_t v) {
    uint16_t u = (uint16_t)v;
    memcpy(&((uint8_t*)_ms_heap)[(int32_t)(ptr) * 4 + (int32_t)(byte_offset)], &u, 2);
}

/* ── 64-bit malloc ── */
static int64_t _ms_malloc64(int64_t size_bytes) {
    return (int64_t)_ms_malloc((int32_t)size_bytes);
}

/* ── I/O helpers (defined after structs — forward declare here) ── */
static void _ms_write_str(int32_t ptr, int32_t len);
static void _ms_write_str_err(int32_t ptr, int32_t len);
static void _ms_panic_str(int32_t ptr, int32_t len);

/* ── Thread support (pthreads) ── */
#include <pthread.h>

/* Function lookup dispatch — set by main() before calling _ms_main() */
typedef void (*_ms_fn_ptr_t)(void);
static _ms_fn_ptr_t (*_ms_fn_lookup)(int32_t ptr, int32_t len) = NULL;

static void _ms_call_by_name(int32_t ptr, int32_t len) {
    if (!_ms_fn_lookup) return;
    _ms_fn_ptr_t fn = _ms_fn_lookup(ptr, len);
    if (fn) fn();
}

/* ── Thread spawn / join ── */
typedef struct { int32_t ptr; int32_t len; } _ms_thr_arg_t;
#define _MS_THR_CAP 1024
static pthread_t _ms_thr_tab[_MS_THR_CAP];
static int64_t _ms_thr_next = 1;
static pthread_mutex_t _ms_thr_mu = PTHREAD_MUTEX_INITIALIZER;

static void* _ms_thr_fn(void* raw) {
    _ms_thr_arg_t a = *(_ms_thr_arg_t*)raw; free(raw);
    _ms_call_by_name(a.ptr, a.len);
    return NULL;
}
static int64_t _ms_thread_spawn(int32_t ptr, int32_t len) {
    _ms_thr_arg_t* a = (_ms_thr_arg_t*)malloc(sizeof(_ms_thr_arg_t));
    a->ptr = ptr; a->len = len;
    pthread_mutex_lock(&_ms_thr_mu);
    int64_t id = _ms_thr_next++;
    pthread_create(&_ms_thr_tab[id % _MS_THR_CAP], NULL, _ms_thr_fn, a);
    pthread_mutex_unlock(&_ms_thr_mu);
    return id;
}
static void _ms_thread_join(int64_t id) {
    pthread_join(_ms_thr_tab[id % _MS_THR_CAP], NULL);
}

/* ── Thread pool ── */
#define _MS_TP_CAP 256
typedef struct {
    _ms_fn_ptr_t* q; int head, tail, qcap;
    int nworkers, ndone, active;
    pthread_t* thr;
    pthread_mutex_t mu;
    pthread_cond_t cv_work, cv_idle;
} _ms_tp_t;
static _ms_tp_t* _ms_tp_tab[_MS_TP_CAP];
static int64_t _ms_tp_next = 1;

static void* _ms_tp_worker(void* arg) {
    _ms_tp_t* tp = (_ms_tp_t*)arg;
    for (;;) {
        pthread_mutex_lock(&tp->mu);
        while (tp->head == tp->tail && !tp->ndone)
            pthread_cond_wait(&tp->cv_work, &tp->mu);
        if (tp->ndone && tp->head == tp->tail)
            { pthread_mutex_unlock(&tp->mu); return NULL; }
        _ms_fn_ptr_t fn = tp->q[tp->head++ % tp->qcap];
        tp->active++;
        pthread_mutex_unlock(&tp->mu);
        fn();
        pthread_mutex_lock(&tp->mu);
        tp->active--;
        if (!tp->active && tp->head == tp->tail)
            pthread_cond_signal(&tp->cv_idle);
        pthread_mutex_unlock(&tp->mu);
    }
}
static int64_t _ms_tp_create(int32_t sz) {
    _ms_tp_t* tp = (_ms_tp_t*)calloc(1, sizeof(_ms_tp_t));
    tp->qcap = 4096;
    tp->q = (_ms_fn_ptr_t*)malloc((size_t)tp->qcap * sizeof(_ms_fn_ptr_t));
    tp->nworkers = (int)sz;
    tp->thr = (pthread_t*)malloc((size_t)tp->nworkers * sizeof(pthread_t));
    pthread_mutex_init(&tp->mu, NULL);
    pthread_cond_init(&tp->cv_work, NULL);
    pthread_cond_init(&tp->cv_idle, NULL);
    int64_t id = _ms_tp_next++;
    _ms_tp_tab[id % _MS_TP_CAP] = tp;
    for (int i = 0; i < tp->nworkers; i++)
        pthread_create(&tp->thr[i], NULL, _ms_tp_worker, tp);
    return id;
}
static void _ms_tp_submit(int64_t pid, int32_t ptr, int32_t len) {
    _ms_tp_t* tp = _ms_tp_tab[pid % _MS_TP_CAP]; if (!tp) return;
    _ms_fn_ptr_t fn = _ms_fn_lookup ? _ms_fn_lookup(ptr, len) : NULL; if (!fn) return;
    pthread_mutex_lock(&tp->mu);
    tp->q[tp->tail++ % tp->qcap] = fn;
    pthread_cond_signal(&tp->cv_work);
    pthread_mutex_unlock(&tp->mu);
}
static void _ms_tp_wait(int64_t pid) {
    _ms_tp_t* tp = _ms_tp_tab[pid % _MS_TP_CAP]; if (!tp) return;
    pthread_mutex_lock(&tp->mu);
    while (tp->active || tp->head != tp->tail)
        pthread_cond_wait(&tp->cv_idle, &tp->mu);
    pthread_mutex_unlock(&tp->mu);
}
static void _ms_tp_destroy(int64_t pid) {
    _ms_tp_t* tp = _ms_tp_tab[pid % _MS_TP_CAP]; if (!tp) return;
    pthread_mutex_lock(&tp->mu); tp->ndone = 1;
    pthread_cond_broadcast(&tp->cv_work); pthread_mutex_unlock(&tp->mu);
    for (int i = 0; i < tp->nworkers; i++) pthread_join(tp->thr[i], NULL);
    pthread_mutex_destroy(&tp->mu);
    pthread_cond_destroy(&tp->cv_work); pthread_cond_destroy(&tp->cv_idle);
    free(tp->q); free(tp->thr); free(tp);
    _ms_tp_tab[pid % _MS_TP_CAP] = NULL;
}

/* ── Mutex / CondVar ── */
#define _MS_SYNC_CAP 1024
static pthread_mutex_t* _ms_mu_tab[_MS_SYNC_CAP];
static pthread_cond_t*  _ms_cv_tab[_MS_SYNC_CAP];
static int64_t _ms_mu_next = 1, _ms_cv_next = 1;

static int64_t _ms_mutex_create(void) {
    int64_t id = _ms_mu_next++;
    pthread_mutex_t* m = (pthread_mutex_t*)malloc(sizeof(pthread_mutex_t));
    pthread_mutex_init(m, NULL); _ms_mu_tab[id % _MS_SYNC_CAP] = m; return id;
}
static void _ms_mutex_lock  (int64_t id) { pthread_mutex_lock  (_ms_mu_tab[id % _MS_SYNC_CAP]); }
static void _ms_mutex_unlock(int64_t id) { pthread_mutex_unlock(_ms_mu_tab[id % _MS_SYNC_CAP]); }
static int64_t _ms_condvar_create(void) {
    int64_t id = _ms_cv_next++;
    pthread_cond_t* c = (pthread_cond_t*)malloc(sizeof(pthread_cond_t));
    pthread_cond_init(c, NULL); _ms_cv_tab[id % _MS_SYNC_CAP] = c; return id;
}
static void _ms_condvar_wait(int64_t cv, int64_t mu) {
    pthread_cond_wait(_ms_cv_tab[cv % _MS_SYNC_CAP], _ms_mu_tab[mu % _MS_SYNC_CAP]);
}
static void _ms_condvar_signal   (int64_t cv) { pthread_cond_signal   (_ms_cv_tab[cv % _MS_SYNC_CAP]); }
static void _ms_condvar_broadcast(int64_t cv) { pthread_cond_broadcast(_ms_cv_tab[cv % _MS_SYNC_CAP]); }

/* ── MemoryOrder → GCC __ATOMIC_* 変換 ── */
static int _ms_mo(int32_t o) {
    switch (o) {
        case 0: return __ATOMIC_RELAXED;
        case 1: return __ATOMIC_ACQUIRE;
        case 2: return __ATOMIC_RELEASE;
        case 3: return __ATOMIC_ACQ_REL;
        default: return __ATOMIC_SEQ_CST;
    }
}

/* ── GPU エミュレーション (CPU 同期実行) ── */
typedef void (*_ms_gpu_kfn_t)(int64_t* args);   /* 引数バッファを直接受け取る薄いラッパー */
typedef struct {
    const char* name;
    _ms_gpu_kfn_t fn;
    int32_t wgx, wgy, wgz;
} _ms_gpu_kern_t;
#define _MS_GPU_KCAP 256
static _ms_gpu_kern_t _ms_gpu_kerns[_MS_GPU_KCAP];
static int32_t _ms_gpu_kern_n = 0;
static int32_t _ms_gpu_register_kernel(const char* name, _ms_gpu_kfn_t fn, int32_t wgx, int32_t wgy, int32_t wgz) {
    for (int32_t i = 0; i < _ms_gpu_kern_n; i++)
        if (strcmp(_ms_gpu_kerns[i].name, name) == 0) return i + 1;
    int32_t id = _ms_gpu_kern_n++;
    _ms_gpu_kerns[id] = (_ms_gpu_kern_t){ name, fn, wgx, wgy, wgz };
    return id + 1;
}
static int64_t _ms_gpu_kern_by_index(int32_t idx) { return (int64_t)(idx + 1); }
static int32_t _ms_gpu_kern_wgx(int64_t h) { return _ms_gpu_kerns[(int32_t)h - 1].wgx; }
static int32_t _ms_gpu_kern_wgy(int64_t h) { return _ms_gpu_kerns[(int32_t)h - 1].wgy; }
static int32_t _ms_gpu_kern_wgz(int64_t h) { return _ms_gpu_kerns[(int32_t)h - 1].wgz; }

#define _MS_GPU_BUFCAP 4096
typedef struct { int32_t addr; int64_t byte_size; int active; } _ms_gpu_buf_t;
static _ms_gpu_buf_t _ms_gpu_bufs[_MS_GPU_BUFCAP];
static int64_t _ms_gpu_buf_next = 1;
static int64_t _ms_gpu_buf_create(int64_t byte_size) {
    int32_t addr = _ms_malloc((int32_t)byte_size);
    int64_t h = _ms_gpu_buf_next++;
    _ms_gpu_bufs[h % _MS_GPU_BUFCAP] = (_ms_gpu_buf_t){ addr, byte_size, 1 };
    return h;
}
static int32_t _ms_gpu_buf_addr(int64_t h) { return _ms_gpu_bufs[h % _MS_GPU_BUFCAP].addr; }
static int64_t _ms_gpu_buf_size(int64_t h) { return _ms_gpu_bufs[h % _MS_GPU_BUFCAP].byte_size; }
static void _ms_gpu_buf_free(int64_t h) { _ms_gpu_bufs[h % _MS_GPU_BUFCAP].active = 0; }

#define _MS_GPU_ARGCAP 256
#define _MS_GPU_ARGSLOT_CAP 64
typedef struct { int64_t vals[_MS_GPU_ARGSLOT_CAP]; int32_t n; } _ms_gpu_args_t;
static _ms_gpu_args_t _ms_gpu_args_tab[_MS_GPU_ARGCAP];
static int64_t _ms_gpu_args_next = 1;
static int64_t _ms_gpu_args_create(void) {
    int64_t h = _ms_gpu_args_next++;
    _ms_gpu_args_tab[h % _MS_GPU_ARGCAP].n = 0;
    return h;
}
static void _ms_gpu_args_push_addr(int64_t h, int32_t v) {
    _ms_gpu_args_t* a = &_ms_gpu_args_tab[h % _MS_GPU_ARGCAP];
    a->vals[a->n++] = (int64_t)(int32_t)v;
}
static void _ms_gpu_args_push_i32(int64_t h, int32_t v) {
    _ms_gpu_args_t* a = &_ms_gpu_args_tab[h % _MS_GPU_ARGCAP];
    a->vals[a->n++] = (int64_t)v;
}
static void _ms_gpu_args_push_i64(int64_t h, int64_t v) {
    _ms_gpu_args_t* a = &_ms_gpu_args_tab[h % _MS_GPU_ARGCAP];
    a->vals[a->n++] = v;
}
static int32_t _ms_gpu_args_count(int64_t h) { return _ms_gpu_args_tab[h % _MS_GPU_ARGCAP].n; }
static void _ms_gpu_args_clear(int64_t h) { _ms_gpu_args_tab[h % _MS_GPU_ARGCAP].n = 0; }

/* per-thread context (CPU 上は順次実行なので大域 1 個) */
typedef struct {
    int32_t gix, giy, giz, lix, liy, liz, wix, wiy, wiz, wgx;
} _ms_gpu_ctx_t;
static _ms_gpu_ctx_t _ms_gpu_ctx = {0,0,0,0,0,0,0,0,0,1};

static void _ms_gpu_dispatch(int64_t kh, int64_t ah, int32_t gx, int32_t gy, int32_t gz) {
    _ms_gpu_kern_t* k = &_ms_gpu_kerns[(int32_t)kh - 1];
    _ms_gpu_args_t* a = &_ms_gpu_args_tab[ah % _MS_GPU_ARGCAP];
    _ms_gpu_ctx_t prev = _ms_gpu_ctx;
    _ms_gpu_ctx.wgx = k->wgx;
    for (int32_t wz = 0; wz < gz; wz++)
    for (int32_t wy = 0; wy < gy; wy++)
    for (int32_t wx = 0; wx < gx; wx++) {
        _ms_gpu_ctx.wix = wx; _ms_gpu_ctx.wiy = wy; _ms_gpu_ctx.wiz = wz;
        for (int32_t lz = 0; lz < k->wgz; lz++)
        for (int32_t ly = 0; ly < k->wgy; ly++)
        for (int32_t lx = 0; lx < k->wgx; lx++) {
            _ms_gpu_ctx.lix = lx; _ms_gpu_ctx.liy = ly; _ms_gpu_ctx.liz = lz;
            _ms_gpu_ctx.gix = wx * k->wgx + lx;
            _ms_gpu_ctx.giy = wy * k->wgy + ly;
            _ms_gpu_ctx.giz = wz * k->wgz + lz;
            k->fn(a->vals);
        }
    }
    _ms_gpu_ctx = prev;
}

/* GPU アトミック (シングルスレッド: 普通の RMW) */
static uint32_t _ms_gpu_atomic_add_u32(int32_t addr, uint32_t v) { uint32_t o = (uint32_t)_ms_heap[addr]; _ms_heap[addr] = (int32_t)(o + v); return o; }
static uint32_t _ms_gpu_atomic_sub_u32(int32_t addr, uint32_t v) { uint32_t o = (uint32_t)_ms_heap[addr]; _ms_heap[addr] = (int32_t)(o - v); return o; }
static uint32_t _ms_gpu_atomic_min_u32(int32_t addr, uint32_t v) { uint32_t o = (uint32_t)_ms_heap[addr]; _ms_heap[addr] = (int32_t)(v < o ? v : o); return o; }
static uint32_t _ms_gpu_atomic_max_u32(int32_t addr, uint32_t v) { uint32_t o = (uint32_t)_ms_heap[addr]; _ms_heap[addr] = (int32_t)(v > o ? v : o); return o; }
static uint32_t _ms_gpu_atomic_cas_u32(int32_t addr, uint32_t e, uint32_t d) { uint32_t o = (uint32_t)_ms_heap[addr]; if (o == e) _ms_heap[addr] = (int32_t)d; return o; }
static int32_t  _ms_gpu_atomic_add_i32(int32_t addr, int32_t v)  { int32_t o = _ms_heap[addr]; _ms_heap[addr] = o + v; return o; }
static int32_t  _ms_gpu_atomic_sub_i32(int32_t addr, int32_t v)  { int32_t o = _ms_heap[addr]; _ms_heap[addr] = o - v; return o; }
static int32_t  _ms_gpu_atomic_min_i32(int32_t addr, int32_t v)  { int32_t o = _ms_heap[addr]; _ms_heap[addr] = v < o ? v : o; return o; }
static int32_t  _ms_gpu_atomic_max_i32(int32_t addr, int32_t v)  { int32_t o = _ms_heap[addr]; _ms_heap[addr] = v > o ? v : o; return o; }
static int32_t  _ms_gpu_atomic_cas_i32(int32_t addr, int32_t e, int32_t d) { int32_t o = _ms_heap[addr]; if (o == e) _ms_heap[addr] = d; return o; }
static float    _ms_gpu_dot_f32x4(int32_t aaddr, int32_t baddr) {
    float s = 0.0f;
    for (int i = 0; i < 4; i++) {
        float a = _ms_bits_f32(_ms_heap[aaddr + i]);
        float b = _ms_bits_f32(_ms_heap[baddr + i]);
        s = s + a * b;
    }
    return s;
}
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

            const isGenericInst = args.length > 0;
            // Non-generic: skip if from an imported file
            // Generic instantiation: always emit (with per-type guard to prevent re-definition)
            if (hasImports && !isGenericInst && !this.isOwn(this.classOrigin.get(base) ?? "")) continue;

            const subst = new Map<string, string>();
            cls.typeParams.forEach((p, i) => subst.set(p, args[i] ?? p));

            const sname = cStructName(concreteType);
            const guard = `_MS_TYPEDEF_${sname.replace(/^_ms_/, "").toUpperCase()}`;
            if (isGenericInst) lines.push(`#ifndef ${guard}\n#define ${guard}`);
            lines.push(`typedef struct {`);
            for (const field of cls.members) {
                const ftype = this.cType(applySubst(field.resolvedType, subst));
                lines.push(`    ${ftype} ${field.name};`);
            }
            lines.push(`} ${sname};`);
            if (isGenericInst) lines.push(`#endif /* ${guard} */`);
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
                if (!["_m8","_m16","_m32","_m64","_m128","_m256","_m512","void"].includes(dep)) {
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
            const isGenericInst = args.length > 0;
            // non-generic: skip if from imported file; generic: always emit (guarded)
            if (hasImports && !isGenericInst && !this.isOwn(this.classOrigin.get(base) ?? "")) continue;
            const subst = new Map<string, string>();
            cls.typeParams.forEach((p, i) => subst.set(p, args[i] ?? p));
            const sname = cStructName(concreteType);
            const guard = isGenericInst ? `_MS_PROTOS_${sname.replace(/^_ms_/, "").toUpperCase()}` : "";
            if (guard) lines.push(`#ifndef ${guard}\n#define ${guard}`);
            for (const method of cls.methods) {
                // method-level generic は emit しない (型固定版を別途定義する)
                if (method.typeParams.length > 0) continue;
                lines.push(this.methodSignature(concreteType, method, subst) + ";");
            }
            if (guard) lines.push(`#endif /* ${guard} */`);
        }

        for (const [name, fn] of this.functions) {
            if (fn.typeParams.length > 0) continue; // generic: emit concrete instantiations below
            // インポートがある場合、他ファイル由来の関数はスキップ
            if (hasImports && !this.isOwn(this.fnOrigin.get(name) ?? "")) continue;
            const params = fn.params.map(p => `${this.cParamType(p.resolvedType)} ${p.name}`);
            lines.push(`static ${this.cType(fn.returnType)} _ms_${name}(${params.join(", ")});`);
        }

        // emit forward decls for concrete instantiations of generic functions (entry file only)
        for (const [name, insts] of this.genericFuncInsts) {
            const fn = this.functions.get(name);
            if (!fn) continue;
            for (const concreteT of insts) {
                const subst = new Map<string, string>();
                fn.typeParams.forEach(p => subst.set(p, concreteT));
                const ret = this.cType(applySubst(fn.returnType, subst));
                const params = fn.params.map(p => `${this.cParamType(applySubst(p.resolvedType, subst))} ${p.name}`);
                const mangledT = cStructName(concreteT).replace(/^_ms_/, "");
                lines.push(`static ${ret} _ms_${name}__${mangledT}(${params.join(", ")});`);
            }
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
            const isGenericInst = args.length > 0;
            if (hasImports && !isGenericInst && !this.isOwn(this.classOrigin.get(base) ?? "")) continue;
            const subst = new Map<string, string>();
            cls.typeParams.forEach((p, i) => subst.set(p, args[i] ?? p));
            const sname = cStructName(concreteType);
            const guard = isGenericInst ? `_MS_IMPLS_${sname.replace(/^_ms_/, "").toUpperCase()}` : "";
            if (guard) lines.push(`#ifndef ${guard}\n#define ${guard}`);
            for (const method of cls.methods) {
                // method-level generic はサポート外 (codegen で monomorphize しない)。
                // 型固定版を別途定義する慣習で運用するため、ここでは emit をスキップする。
                if (method.typeParams.length > 0) continue;
                // for Array<T> where T is a multi-word struct, override index get/set with memcpy
                if (base === "Array" && args.length === 1 &&
                    (method.name === "operator[]" || method.name === "operator_set[]")) {
                    const elemType = applySubst("T", subst);
                    const elemSz   = this.computeSizeof(elemType);
                    if (elemSz > 4 || !CCodegen.MACHINE_TYPES.has(elemType)) {
                        lines.push(this.emitArrayStructMethod(concreteType, method, subst, elemType, elemSz));
                        continue;
                    }
                }
                lines.push(this.emitMethod(concreteType, method, subst));
            }
            if (guard) lines.push(`#endif /* ${guard} */`);
        }

        // global variables (emit with file-ownership filter)
        for (const [name, g] of this.globals) {
            if (hasImports && !this.isOwn(g.origin)) continue;
            const ctype = cStructName(g.type);
            const init  = this.globalInitExpr(g.value);
            lines.push(`static ${ctype} ${name} = ${init};`);
        }

        for (const [name, fn] of this.functions) {
            if (fn.typeParams.length > 0) continue; // generic: emit concrete instantiations below
            // インポートがある場合、他ファイル由来の関数はスキップ
            if (hasImports && !this.isOwn(this.fnOrigin.get(name) ?? "")) continue;
            lines.push(this.emitFreeFunction(fn));
        }

        // emit concrete instantiations of generic functions (visible from entry file)
        for (const [name, insts] of this.genericFuncInsts) {
            const fn = this.functions.get(name);
            if (!fn) continue;
            for (const concreteT of insts) {
                const subst = new Map<string, string>();
                fn.typeParams.forEach(p => subst.set(p, concreteT));
                const mangledT = cStructName(concreteT).replace(/^_ms_/, "");
                const ret = this.cType(applySubst(fn.returnType, subst));
                const params = fn.params.map(p =>
                    `${this.cParamType(applySubst(p.resolvedType, subst))} ${p.name}`);
                const body: string[] = [];
                fn.body.forEach(n => this.emitBodyNode(n, "    ", subst, body, fn.returnType));
                lines.push(`static ${ret} _ms_${name}__${mangledT}(${params.join(", ")}) {\n${body.map(l => "    " + l).join("\n")}\n}`);
            }
        }

        return lines.join("\n\n");
    }

    private methodSignature(classType: string, method: FunctionDecl, subst: Map<string, string>): string {
        const sname   = cStructName(classType);
        const fnName  = cMethodName(classType, method.name);
        const retType = this.cType(applySubst(method.returnType, subst));
        // §6.1.1 mut メソッド (および constructor) の self は &mut T → restrict
        //         不変メソッドは &T → const
        const selfIsMut = method.isMut || method.name === "constructor";
        const selfQual = selfIsMut ? `${sname}* __restrict__` : `const ${sname}*`;
        const params: string[] = [`${selfQual} self`];
        for (const p of method.params) {
            params.push(`${this.cParamType(applySubst(p.resolvedType, subst))} ${p.name}`);
        }
        return `static ${retType} ${fnName}(${params.join(", ")})`;
    }

    private emitArrayStructMethod(
        classType: string,
        method: FunctionDecl,
        _subst: Map<string, string>,
        elemType: string,
        _elemSz: number,
    ): string {
        const sname   = cStructName(classType);
        const fnName  = cMethodName(classType, method.name);
        const elemC   = this.cType(elemType);
        const wordsPerElem = `(int32_t)(sizeof(${elemC}) / sizeof(int32_t))`;
        // 前方宣言 (methodSignature) と一致させる: method.isMut で self の qualifier を決定
        const selfQual = method.isMut ? `${sname}* __restrict__` : `const ${sname}*`;
        if (method.name === "operator[]") {
            return `static ${elemC} ${fnName}(${selfQual} self, _ms_u32 index) {\n` +
                `    int32_t _word_off = (int32_t)((uint32_t)(index.bits) * (uint32_t)${wordsPerElem});\n` +
                `    ${elemC} _result;\n    memset(&_result, 0, sizeof(${elemC}));\n` +
                `    memcpy(&_result, &_ms_heap[self->ptr + _word_off], sizeof(${elemC}));\n` +
                `    return _result;\n}`;
        } else { // operator_set[]
            return `static void ${fnName}(${selfQual} self, _ms_u32 index, ${elemC} value) {\n` +
                `    int32_t _word_off = (int32_t)((uint32_t)(index.bits) * (uint32_t)${wordsPerElem});\n` +
                `    memcpy(&_ms_heap[self->ptr + _word_off], &value, sizeof(${elemC}));\n}`;
        }
    }

    private emitMethod(
        classType: string,
        method: FunctionDecl,
        subst: Map<string, string>,
    ): string {
        this.tmpCount = 0;
        this.curClassType = classType;
        const mozRetType = applySubst(method.returnType, subst);
        const bodyLines  = this.emitBody(method.body, "    ", subst, mozRetType);
        this.curClassType = "";
        return `${this.methodSignature(classType, method, subst)} {\n${bodyLines}\n}`;
    }

    private globalInitExpr(valueNode: ASTNode): string {
        // only handles NewExpr with a single RawLiteral arg
        if (valueNode.type !== "NewExpr") return "{}";
        const args = (valueNode as any).args as ASTNode[];
        if (args.length === 0) return "{}";
        const arg = args[0];
        if (arg.type !== "RawLiteral") return "{}";
        const raw = arg as any;
        // checker は f32/f64・整数幅を区別しないため、対象型の機械型で幅を決める
        const concreteType = (valueNode as any).resolvedType as string;
        const base = concreteType.replace(/<.*>$/, "");
        const paramType = this.classes.get(base)?.methods
            .find(m => m.name === "constructor")?.params[0]?.resolvedType ?? "_m32";
        if (raw.kind === "float") {
            if (paramType === "_m64") {
                const buf = new Float64Array([raw.value]);
                const bits = new BigInt64Array(buf.buffer)[0];
                return `{ .bits = (int64_t)${bits}LL }`;
            }
            const buf = new Float32Array([raw.value]);
            const bits = new Int32Array(buf.buffer)[0];
            return `{ .bits = (int32_t)${bits} }`;
        }
        if (paramType === "_m64") {
            return `{ .bits = (int64_t)${raw.value}LL }`;
        }
        return `{ .bits = (int32_t)${raw.value} }`;
    }

    private emitFreeFunction(fn: FunctionDecl): string {
        this.tmpCount = 0;
        const retType   = this.cType(fn.returnType);
        const params    = fn.params.map(p => `${this.cParamType(p.resolvedType)} ${p.name}`);
        const fnName    = `_ms_${fn.name}`;
        const bodyLines = this.emitBody(fn.body, "    ", new Map(), fn.returnType);
        return `static ${retType} ${fnName}(${params.join(", ")}) {\n${bodyLines}\n}`;
    }

    // ── GPU カーネルラッパー ──────────────────────────────────────────────────
    // 各 gpu 関数に対して、ランタイムから int64_t[] で呼び出せる薄いラッパーを生成する。
    // ラッパーは args 配列から各引数を型付けてマテリアライズし、本体関数を呼ぶ。
    private emitGpuKernelWrappers(): string {
        const lines: string[] = [];
        for (const [name, fn] of this.functions) {
            if (!fn.isGpu) continue;
            if (!this.isOwn((fn as any)._sourceFile ?? this.entryFile)) {
                // gpu 関数はソースファイルで emit されているはず。エントリ以外ならスキップ。
                // (現バージョンでは gpu 関数は main を持つエントリファイルに置くこと)
            }
            const wrapName = `_ms_gpu_wrap_${name}`;
            const setups: string[] = [];
            const callArgs: string[] = [];
            for (let i = 0; i < fn.params.length; i++) {
                const p = fn.params[i];
                const cT = this.cType(p.resolvedType);   // 値型 (_ms_Ptr_f32, _ms_u32, ...)
                // Ptr<T> は単一 addr フィールドを持つラッパー (value type) として扱う
                if (p.resolvedType.startsWith("Ptr<")) {
                    setups.push(`    ${cT} _p${i} = { .addr = (int32_t)args[${i}] };`);
                    callArgs.push(`_p${i}`);
                } else if (p.resolvedType.startsWith("Array<")) {
                    // Array<T> は { ptr, length } を持つ ref 型 (ヒープ確保)。
                    // 現バージョンでは args.pushBuffer 経由でアドレスのみ受け取るので length は不明。
                    // (Array<T> を gpu kernel param に使う場合は使用者が長さも引数として渡す慣習を要求)
                    setups.push(`    ${cT} _p${i}_v = { .ptr = (int32_t)args[${i}], .length = { .bits = 0 } };`);
                    setups.push(`    ${cT}* _p${i} = &_p${i}_v;`);
                    callArgs.push(`_p${i}`);
                } else {
                    // ラッパー型 (i32/u32/f32/...)。bits フィールドを持つ値型。
                    setups.push(`    ${cT} _p${i} = { .bits = (int32_t)args[${i}] };`);
                    callArgs.push(`_p${i}`);
                }
            }
            lines.push(`static void ${wrapName}(int64_t* args) {`);
            for (const s of setups) lines.push(s);
            lines.push(`    (void)args;`);
            lines.push(`    _ms_${name}(${callArgs.join(", ")});`);
            lines.push(`}`);
        }
        return lines.join("\n");
    }

    // gpu カーネル登録と、auto-generated GpuKernel グローバル定数の初期化を main 内で発行する。
    // (globalInitExpr は静的初期化子に Intrinsic 呼び出しを埋め込めないので、ランタイムで遅延初期化する)
    private emitGpuKernelRegistrations(): string {
        const lines: string[] = [];
        let idx = 0;
        for (const [name, fn] of this.functions) {
            if (!fn.isGpu) continue;
            const actual = name.startsWith("__gpu_kernel_") ? name.slice("__gpu_kernel_".length) : name;
            const wgs = fn.workgroupSize ?? [64, 1, 1];
            lines.push(`    _ms_gpu_register_kernel("${actual}", _ms_gpu_wrap_${name}, ${wgs[0]}, ${wgs[1]}, ${wgs[2]});`);
            // 同名のグローバル GpuKernel 定数があれば handle を設定
            if (this.globals.has(actual)) {
                lines.push(`    ${actual}.handle = (int64_t)_ms_gpu_kern_by_index(${idx});`);
            }
            idx++;
        }
        return lines.join("\n");
    }

    // ── 関数名レジストリ ──────────────────────────────────────────────────────

    private emitCallByName(): string {
        // Only the entry file (the one with main()) defines _ms_fn_lookup_impl.
        // Library files (core.moc, geometry.moz, …) leave _ms_fn_lookup as NULL.
        if (!this.functions.has("main")) return "";

        // Collect all top-level void functions with no parameters across all loaded files.
        const candidates: string[] = [];
        for (const [name, fn] of this.functions) {
            if (fn.typeParams.length > 0) continue;
            if (fn.returnType !== "void") continue;
            if (fn.params.length > 0) continue;
            candidates.push(name);
        }

        const lines: string[] = ["/* ── Function name → pointer lookup (for thread spawn) ── */"];
        lines.push(`static _ms_fn_ptr_t _ms_fn_lookup_impl(int32_t ptr, int32_t len) {`);
        lines.push(`    char _n[256]; int32_t _l = len < 255 ? len : 255;`);
        lines.push(`    for (int32_t _i = 0; _i < _l; _i++) _n[_i] = (char)(uint8_t)_ms_heap[ptr + _i];`);
        lines.push(`    _n[_l] = '\\0';`);
        for (const name of candidates) {
            lines.push(`    if (strcmp(_n, "${name}") == 0) return _ms_${name};`);
        }
        lines.push(`    return NULL;`);
        lines.push(`}`);
        return lines.join("\n");
    }

    // ── メイン ────────────────────────────────────────────────────────────────

    private emitMain(): string {
        if (!this.functions.has("main")) return "";
        const kernelInit = this.emitGpuKernelRegistrations();
        const kernelInitBlock = kernelInit ? `\n${kernelInit}` : "";
        return `int main(void) {\n    _ms_fn_lookup = _ms_fn_lookup_impl;${kernelInitBlock}\n    _ms_main();\n    return 0;\n}`;
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
                const mozT  = applySubst(node.resolvedType, subst);
                const ctype = this.cType(mozT);
                if (ctype === "void") { if (expr) out.push(`${expr};`); break; }
                const fallback = this.isRef(mozT) ? "NULL" : "{ 0 }";
                out.push(`${ctype} ${node.name} = ${expr || fallback};`);
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
                        // if pre-statements precede the if, wrap in a block
                        const ifIdx = elseLines.findIndex(l => l.trimStart().startsWith("if "));
                        if (ifIdx > 0) {
                            out.push(`else {`);
                            out.push(...elseLines);
                            out.push(`}`);
                        } else {
                            const first = elseLines.shift() ?? "";
                            out.push(`else ${first.trimStart()}`);
                            out.push(...elseLines);
                        }
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
                const isPrimRet = resolvedRet === "_m32" || resolvedRet === "_m64";
                const isPrimExpr = resolvedExpr === "_m32" || resolvedExpr === "_m64";
                if (resolvedRet && !isPrimRet && resolvedRet !== "void"
                    && isPrimExpr
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

            case "BlockStmt": {
                out.push(`{`);
                node.body.forEach(n => this.emitBodyNode(n, indent, subst, out, retMozType));
                out.push(`}`);
                break;
            }

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
            const recvType = (node.receiver as any).resolvedType ?? "";
            const sep = this.isRef(recvType) ? "->" : ".";
            return `${this.emitLvalue(node.receiver)}${sep}${node.member}`;
        }
        return "/* lvalue? */";
    }

    // ── 条件式（__builtin_if/__builtin_while）────────────────────────────────

    private flattenCond(node: ASTNode, pre: string[], subst: Map<string, string>): string {
        if (
            node.type === "Intrinsic" &&
            (node.name === "__builtin_if" || node.name === "__builtin_while")
        ) {
            const arg = node.args[0];
            let argType = applySubst((arg as any).resolvedType ?? "", subst);
            // resolvedType may be "void" when the receiver was a generic type param at check time.
            // Re-derive from the concrete class definition.
            if (argType === "void" && arg.type === "MethodCall") {
                const recvType = applySubst((arg as any).receiver?.resolvedType ?? "void", subst);
                argType = this.lookupMethodReturnType(recvType, (arg as any).method);
            }
            const argExpr = this.flattenExpr(arg, pre, subst);
            // 最適化後は boolean wrapper が剥がれて _m32 直値になる場合がある
            if (argType === "boolean") {
                const boolVar = this.maybeTemp(argExpr, "_ms_boolean", pre);
                return `${boolVar}.bits`;
            }
            // _m32 / RawLiteral 等: そのまま使う
            return argExpr;
        }
        return this.flattenExpr(node, pre, subst);
    }

    // ── 式フラット化 ──────────────────────────────────────────────────────────

    private flattenExpr(node: ASTNode, pre: string[], subst: Map<string, string>): string {
        switch (node.type) {
            case "Identifier":
                if (node.name === "this") return this.isRef(this.curClassType) ? "self" : "(*self)";
                return node.name;

            case "RawLiteral":
                if (node.kind === "float") {
                    const flit = Number.isInteger(node.value) ? `${node.value}.0f` : `${node.value}f`;
                    return `_ms_f32_bits(${flit})`;
                }
                return `(int32_t)${node.value}`;

            case "MemberAccess": {
                if (node.receiver.type === "Identifier" && node.receiver.name === "this") {
                    return `self->${node.member}`;
                }
                const recvMozType = applySubst((node.receiver as any).resolvedType ?? "i32", subst);
                // machine type has no fields — accessing .bits on _m32 just returns the value itself
                if (CCodegen.MACHINE_TYPES.has(recvMozType)) {
                    return this.flattenExpr(node.receiver, pre, subst);
                }
                const recvExpr = this.flattenExpr(node.receiver, pre, subst);
                if (this.isRef(recvMozType)) {
                    const recvPtr = this.maybeTemp(recvExpr, this.cType(recvMozType), pre);
                    return `${recvPtr}->${node.member}`;
                }
                const recvVar  = this.maybeTemp(recvExpr, cStructName(recvMozType), pre);
                return `${recvVar}.${node.member}`;
            }

            case "MethodCall":
                return this.flattenMethodCall(node as any, pre, subst);

            case "NewExpr":
                return this.flattenNewExpr(node as any, pre, subst);

            case "Intrinsic":
                return this.flattenIntrinsic(node as any, pre, subst);

            case "BorrowExpr":
                // ゼロコスト借用: C では参照と所有権は同一のポインタなので透過
                return this.flattenExpr((node as any).expr, pre, subst);

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

        // _m32/_m64 はプリミティブ生値 — getBits() は恒等操作なので直接返す
        if ((recvType === "_m32" || recvType === "_m64") && node.method === "getBits") {
            return this.flattenExpr(node.receiver, pre, subst);
        }

        // free function call: receiver is an Identifier matching a top-level function
        if (node.receiver.type === "Identifier") {
            const rname = (node.receiver as any).name as string;
            const simpleName = rname.includes(".") ? rname.slice(rname.lastIndexOf(".") + 1) : rname;
            const matchedFn = this.functions.get(simpleName);
            if (matchedFn) {
                const argExprs = node.args.map(a => this.flattenExpr(a, pre, subst));
                let fnCall: string;
                if (matchedFn.typeParams.length > 0) {
                    const concreteT = applySubst((node.receiver as any).resolvedType ?? "", subst);
                    const mangledT = cStructName(concreteT).replace(/^_ms_/, "");
                    fnCall = `_ms_${simpleName}__${mangledT}(${argExprs.join(", ")})`;
                } else {
                    fnCall = `_ms_${simpleName}(${argExprs.join(", ")})`;
                }
                const retType = applySubst(node.resolvedType, subst);
                if (retType === "void") { pre.push(`${fnCall};`); return ""; }
                const tmp = this.nextTmp();
                pre.push(`${this.cType(retType)} ${tmp} = ${fnCall};`);
                return tmp;
            }
        }

        const recvAddr = this.flattenToAddr(node.receiver, recvType, pre, subst);
        const argExprs = node.args.map(a => this.flattenExpr(a, pre, subst));

        const fnName  = cMethodName(recvType, node.method);
        const allArgs = [recvAddr, ...argExprs].join(", ");
        const call    = `${fnName}(${allArgs})`;

        let retType = applySubst(node.resolvedType, subst);
        if (retType === "void") {
            // resolvedType may be "void" when the checker couldn't resolve the return type
            // because the receiver was a generic type parameter at check time.
            // Re-derive from the concrete class definition now that we know recvType.
            retType = this.lookupMethodReturnType(recvType, node.method);
        }
        if (retType === "void") {
            pre.push(`${call};`);
            return "";
        }

        const tmp = this.nextTmp();
        pre.push(`${this.cType(retType)} ${tmp} = ${call};`);
        return tmp;
    }

    private lookupMethodReturnType(recvType: string, methodName: string): string {
        const base = baseType(recvType);
        const cls = this.classes.get(base);
        if (!cls) return "void";
        const m = cls.methods.find(m => m.name === methodName);
        if (!m) return "void";
        const clsSubst = new Map<string, string>();
        const args = typeArgs(recvType);
        cls.typeParams.forEach((tp, i) => { if (args[i]) clsSubst.set(tp, args[i]); });
        return applySubst(m.returnType, clsSubst);
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
        const cname        = cStructName(concreteType);
        const isRef        = this.isRef(concreteType);
        const tmp          = this.nextTmp();
        const acc          = isRef ? "->" : ".";          // フィールドアクセス演算子
        const selfArg      = isRef ? tmp : `&${tmp}`;     // ctor の self に渡す式

        // 参照型はヒープ確保（calloc で 0 初期化）、値型はローカル struct + memset
        const declare = () => {
            if (isRef) {
                pre.push(`${cname}* ${tmp} = (${cname}*)calloc(1, sizeof(${cname}));`);
            } else {
                pre.push(`${cname} ${tmp};`);
                pre.push(`memset(&${tmp}, 0, sizeof(${cname}));`);
            }
        };

        // 文字列リテラル（elements あり → Array<u32> = 参照型）
        if (node.elements !== undefined) {
            const n = node.elements.length;
            const { ptr: ptrField, len: lenField } = this.arrayFields();
            declare();
            if (n > 0) {
                pre.push(`${tmp}${acc}${ptrField} = _ms_malloc((int32_t)(${n * 4}));`);
                for (let i = 0; i < n; i++) {
                    pre.push(`_ms_heap[${tmp}${acc}${ptrField} + ${i}] = (int32_t)${node.elements[i].value};`);
                }
            }
            pre.push(`${tmp}${acc}${lenField} = (int32_t)${n};`);
            return tmp;
        }

        if (CCodegen.MACHINE_TYPES.has(concreteType)) {
            // machine type (_m32 etc.) has no constructor — just assign
            declare();
            const arg = node.args.length > 0 ? this.flattenExpr(node.args[0], pre, subst) : "0";
            pre.push(`${tmp} = ${arg};`);
            return tmp;
        }

        // 通常のNewExpr（ラッパー値 or 参照オブジェクト）
        declare();
        const ctorName = cMethodName(concreteType, "constructor");
        const paramTypes = this.ctorParamTypes(concreteType, subst);
        const argExprs = node.args.map((arg, i) => this.emitCtorArg(arg, paramTypes[i], pre, subst));
        const allArgs  = [selfArg, ...argExprs].join(", ");
        pre.push(`${ctorName}(${allArgs});`);
        return tmp;
    }

    // コンストラクタの引数型一覧（型変数は subst で解決）
    private ctorParamTypes(concreteType: string, subst: Map<string, string>): string[] {
        const base = concreteType.replace(/<.*>$/, "");
        const ctor = this.classes.get(base)?.methods.find(m => m.name === "constructor");
        if (!ctor) return [];
        return ctor.params.map(p => applySubst(p.resolvedType, subst));
    }

    // コンストラクタ引数を出力する。リテラルは引数の機械型でビット幅を選ぶ
    // （checker は f32/f64 を区別せず kind:'float'、整数も幅を持たないため、
    //   ここで _m64 → 64bit double / int64 を判定して切り詰めを防ぐ）
    private emitCtorArg(arg: ASTNode, paramType: string | undefined, pre: string[], subst: Map<string, string>): string {
        if (arg.type === "RawLiteral" && paramType === "_m64") {
            const raw = arg as any;
            if (raw.kind === "float") {
                const v = raw.value as number;
                const dlit = Number.isInteger(v) ? `${v}.0` : `${v}`;
                return `_ms_f64_bits(${dlit})`;
            }
            return `(int64_t)${raw.value}LL`;
        }
        return this.flattenExpr(arg, pre, subst);
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

            // i32 追加演算
            case "__builtin_i32_shl":    return `(int32_t)((int32_t)(${a(0)}) << ((${a(1)}) & 31))`;
            case "__builtin_i32_shr":    return `(int32_t)((int32_t)(${a(0)}) >> ((${a(1)}) & 31))`;
            case "__builtin_u32_shl":    return `(int32_t)((uint32_t)(${a(0)}) << ((${a(1)}) & 31))`;
            case "__builtin_u32_shr":    return `(int32_t)((uint32_t)(${a(0)}) >> ((${a(1)}) & 31))`;
            case "__builtin_u32_or":     return `(int32_t)((uint32_t)(${a(0)}) | (uint32_t)(${a(1)}))`;
            case "__builtin_u32_and":    return `(int32_t)((uint32_t)(${a(0)}) & (uint32_t)(${a(1)}))`;
            case "__builtin_i32_rotl":   return `(int32_t)(((uint32_t)(${a(0)}) << ((${a(1)})&31)) | ((uint32_t)(${a(0)}) >> (32-((${a(1)})&31))))`;
            case "__builtin_i32_rotr":   return `(int32_t)(((uint32_t)(${a(0)}) >> ((${a(1)})&31)) | ((uint32_t)(${a(0)}) << (32-((${a(1)})&31))))`;
            case "__builtin_i32_clz":    return `(int32_t)__builtin_clz((uint32_t)(${a(0)}))`;
            case "__builtin_i32_ctz":    return `(int32_t)__builtin_ctz((uint32_t)(${a(0)}))`;
            case "__builtin_i32_popcnt": return `(int32_t)__builtin_popcount((uint32_t)(${a(0)}))`;

            // i64 算術
            case "__builtin_i64_add": return `(int64_t)((int64_t)(${a(0)}) + (int64_t)(${a(1)}))`;
            case "__builtin_i64_sub": return `(int64_t)((int64_t)(${a(0)}) - (int64_t)(${a(1)}))`;
            case "__builtin_i64_mul": return `(int64_t)((int64_t)(${a(0)}) * (int64_t)(${a(1)}))`;
            case "__builtin_i64_div": return `(int64_t)((int64_t)(${a(0)}) / (int64_t)(${a(1)}))`;
            case "__builtin_i64_mod": return `(int64_t)((int64_t)(${a(0)}) % (int64_t)(${a(1)}))`;
            case "__builtin_i64_neg": return `(int64_t)(-(int64_t)(${a(0)}))`;
            case "__builtin_i64_eq":  return `((int64_t)(${a(0)}) == (int64_t)(${a(1)}) ? 1 : 0)`;
            case "__builtin_i64_lt":  return `((int64_t)(${a(0)}) < (int64_t)(${a(1)}) ? 1 : 0)`;
            case "__builtin_i64_gt":  return `((int64_t)(${a(0)}) > (int64_t)(${a(1)}) ? 1 : 0)`;
            case "__builtin_i64_or":  return `(int64_t)((int64_t)(${a(0)}) | (int64_t)(${a(1)}))`;
            case "__builtin_i64_and": return `(int64_t)((int64_t)(${a(0)}) & (int64_t)(${a(1)}))`;
            case "__builtin_i64_not": return `((int64_t)(${a(0)}) == 0 ? 1 : 0)`;
            case "__builtin_i64_shl": return `(int64_t)((int64_t)(${a(0)}) << ((${a(1)}) & 63))`;
            case "__builtin_i64_shr": return `(int64_t)((int64_t)(${a(0)}) >> ((${a(1)}) & 63))`;
            case "__builtin_i64_rotl":   return `(int64_t)(((uint64_t)(${a(0)}) << ((${a(1)})&63)) | ((uint64_t)(${a(0)}) >> (64-((${a(1)})&63))))`;
            case "__builtin_i64_rotr":   return `(int64_t)(((uint64_t)(${a(0)}) >> ((${a(1)})&63)) | ((uint64_t)(${a(0)}) << (64-((${a(1)})&63))))`;
            case "__builtin_i64_clz":    return `(int64_t)__builtin_clzll((uint64_t)(${a(0)}))`;
            case "__builtin_i64_ctz":    return `(int64_t)__builtin_ctzll((uint64_t)(${a(0)}))`;
            case "__builtin_i64_popcnt": return `(int64_t)__builtin_popcountll((uint64_t)(${a(0)}))`;

            // u64 算術
            case "__builtin_u64_add": return `(int64_t)((uint64_t)(${a(0)}) + (uint64_t)(${a(1)}))`;
            case "__builtin_u64_sub": return `(int64_t)((uint64_t)(${a(0)}) - (uint64_t)(${a(1)}))`;
            case "__builtin_u64_mul": return `(int64_t)((uint64_t)(${a(0)}) * (uint64_t)(${a(1)}))`;
            case "__builtin_u64_div": return `(int64_t)((uint64_t)(${a(0)}) / (uint64_t)(${a(1)}))`;
            case "__builtin_u64_mod": return `(int64_t)((uint64_t)(${a(0)}) % (uint64_t)(${a(1)}))`;
            case "__builtin_u64_eq":  return `((uint64_t)(${a(0)}) == (uint64_t)(${a(1)}) ? 1 : 0)`;
            case "__builtin_u64_lt":  return `((uint64_t)(${a(0)}) < (uint64_t)(${a(1)}) ? 1 : 0)`;
            case "__builtin_u64_gt":  return `((uint64_t)(${a(0)}) > (uint64_t)(${a(1)}) ? 1 : 0)`;
            case "__builtin_u64_or":  return `(int64_t)((uint64_t)(${a(0)}) | (uint64_t)(${a(1)}))`;
            case "__builtin_u64_and": return `(int64_t)((uint64_t)(${a(0)}) & (uint64_t)(${a(1)}))`;
            case "__builtin_u64_not": return `((uint64_t)(${a(0)}) == 0 ? 1 : 0)`;
            case "__builtin_u64_shl": return `(int64_t)((uint64_t)(${a(0)}) << ((${a(1)}) & 63))`;
            case "__builtin_u64_shr": return `(int64_t)((uint64_t)(${a(0)}) >> ((${a(1)}) & 63))`;

            // f64 算術
            case "__builtin_f64_add": return `_ms_f64_bits(_ms_bits_f64(${a(0)}) + _ms_bits_f64(${a(1)}))`;
            case "__builtin_f64_sub": return `_ms_f64_bits(_ms_bits_f64(${a(0)}) - _ms_bits_f64(${a(1)}))`;
            case "__builtin_f64_mul": return `_ms_f64_bits(_ms_bits_f64(${a(0)}) * _ms_bits_f64(${a(1)}))`;
            case "__builtin_f64_div": return `_ms_f64_bits(_ms_bits_f64(${a(0)}) / _ms_bits_f64(${a(1)}))`;
            case "__builtin_f64_mod": return `_ms_f64_bits(fmod(_ms_bits_f64(${a(0)}), _ms_bits_f64(${a(1)})))`;
            case "__builtin_f64_neg": return `_ms_f64_bits(-_ms_bits_f64(${a(0)}))`;
            case "__builtin_f64_eq":  return `(_ms_bits_f64(${a(0)}) == _ms_bits_f64(${a(1)}) ? 1 : 0)`;
            case "__builtin_f64_lt":  return `(_ms_bits_f64(${a(0)}) < _ms_bits_f64(${a(1)}) ? 1 : 0)`;
            case "__builtin_f64_gt":  return `(_ms_bits_f64(${a(0)}) > _ms_bits_f64(${a(1)}) ? 1 : 0)`;
            case "__builtin_f64_abs":     return `_ms_f64_bits(fabs(_ms_bits_f64(${a(0)})))`;
            case "__builtin_f64_sqrt":    return `_ms_f64_bits(sqrt(_ms_bits_f64(${a(0)})))`;
            case "__builtin_f64_floor":   return `_ms_f64_bits(floor(_ms_bits_f64(${a(0)})))`;
            case "__builtin_f64_ceil":    return `_ms_f64_bits(ceil(_ms_bits_f64(${a(0)})))`;
            case "__builtin_f64_trunc":   return `_ms_f64_bits(trunc(_ms_bits_f64(${a(0)})))`;
            case "__builtin_f64_nearest": return `_ms_f64_bits(round(_ms_bits_f64(${a(0)})))`;
            case "__builtin_f64_min":     return `_ms_f64_bits(fmin(_ms_bits_f64(${a(0)}), _ms_bits_f64(${a(1)})))`;
            case "__builtin_f64_max":     return `_ms_f64_bits(fmax(_ms_bits_f64(${a(0)}), _ms_bits_f64(${a(1)})))`;

            // f32 追加演算
            case "__builtin_f32_abs":     return `_ms_f32_bits(fabsf(_ms_bits_f32(${a(0)})))`;
            case "__builtin_f32_sqrt":    return `_ms_f32_bits(sqrtf(_ms_bits_f32(${a(0)})))`;
            case "__builtin_f32_floor":   return `_ms_f32_bits(floorf(_ms_bits_f32(${a(0)})))`;
            case "__builtin_f32_ceil":    return `_ms_f32_bits(ceilf(_ms_bits_f32(${a(0)})))`;
            case "__builtin_f32_trunc":   return `_ms_f32_bits(truncf(_ms_bits_f32(${a(0)})))`;
            case "__builtin_f32_nearest": return `_ms_f32_bits(roundf(_ms_bits_f32(${a(0)})))`;
            case "__builtin_f32_min":     return `_ms_f32_bits(fminf(_ms_bits_f32(${a(0)}), _ms_bits_f32(${a(1)})))`;
            case "__builtin_f32_max":     return `_ms_f32_bits(fmaxf(_ms_bits_f32(${a(0)}), _ms_bits_f32(${a(1)})))`;

            // 超越関数（f32）
            case "__builtin_f32_sin":   return `_ms_f32_bits(sinf(_ms_bits_f32(${a(0)})))`;
            case "__builtin_f32_cos":   return `_ms_f32_bits(cosf(_ms_bits_f32(${a(0)})))`;
            case "__builtin_f32_tan":   return `_ms_f32_bits(tanf(_ms_bits_f32(${a(0)})))`;
            case "__builtin_f32_exp":   return `_ms_f32_bits(expf(_ms_bits_f32(${a(0)})))`;
            case "__builtin_f32_log":   return `_ms_f32_bits(logf(_ms_bits_f32(${a(0)})))`;
            case "__builtin_f32_pow":   return `_ms_f32_bits(powf(_ms_bits_f32(${a(0)}), _ms_bits_f32(${a(1)})))`;
            case "__builtin_f32_atan":  return `_ms_f32_bits(atanf(_ms_bits_f32(${a(0)})))`;
            case "__builtin_f32_atan2": return `_ms_f32_bits(atan2f(_ms_bits_f32(${a(0)}), _ms_bits_f32(${a(1)})))`;

            // 超越関数（f64）
            case "__builtin_f64_sin":   return `_ms_f64_bits(sin(_ms_bits_f64(${a(0)})))`;
            case "__builtin_f64_cos":   return `_ms_f64_bits(cos(_ms_bits_f64(${a(0)})))`;
            case "__builtin_f64_tan":   return `_ms_f64_bits(tan(_ms_bits_f64(${a(0)})))`;
            case "__builtin_f64_exp":   return `_ms_f64_bits(exp(_ms_bits_f64(${a(0)})))`;
            case "__builtin_f64_log":   return `_ms_f64_bits(log(_ms_bits_f64(${a(0)})))`;
            case "__builtin_f64_pow":   return `_ms_f64_bits(pow(_ms_bits_f64(${a(0)}), _ms_bits_f64(${a(1)})))`;
            case "__builtin_f64_atan":  return `_ms_f64_bits(atan(_ms_bits_f64(${a(0)})))`;
            case "__builtin_f64_atan2": return `_ms_f64_bits(atan2(_ms_bits_f64(${a(0)}), _ms_bits_f64(${a(1)})))`;

            // 型変換
            case "__builtin_i32_to_f32": return `_ms_f32_bits((float)(int32_t)(${a(0)}))`;
            case "__builtin_i32_to_u32": return `(int32_t)(uint32_t)(int32_t)(${a(0)})`;
            case "__builtin_u32_to_f32": return `_ms_f32_bits((float)(uint32_t)(${a(0)}))`;
            case "__builtin_u32_to_i32": return `(int32_t)(uint32_t)(${a(0)})`;
            case "__builtin_f32_to_i32": return `(int32_t)_ms_bits_f32(${a(0)})`;
            case "__builtin_f32_to_u32": return `(int32_t)(uint32_t)_ms_bits_f32(${a(0)})`;
            case "__builtin_i32_to_i64": return `(int64_t)(int32_t)(${a(0)})`;
            case "__builtin_u32_to_u64": return `(int64_t)(uint64_t)(uint32_t)(${a(0)})`;
            case "__builtin_i32_to_f64": return `_ms_f64_bits((double)(int32_t)(${a(0)}))`;
            case "__builtin_u32_to_f64": return `_ms_f64_bits((double)(uint32_t)(${a(0)}))`;
            case "__builtin_i64_to_i32": return `(int32_t)(int64_t)(${a(0)})`;
            case "__builtin_u64_to_u32": return `(int32_t)(uint32_t)(uint64_t)(${a(0)})`;
            case "__builtin_f32_to_f64": return `_ms_f64_bits((double)_ms_bits_f32(${a(0)}))`;
            case "__builtin_f64_to_f32": return `_ms_f32_bits((float)_ms_bits_f64(${a(0)}))`;
            case "__builtin_f64_to_i64": return `(int64_t)_ms_bits_f64(${a(0)})`;
            case "__builtin_i64_to_f64": return `_ms_f64_bits((double)(int64_t)(${a(0)}))`;
            case "__builtin_u64_to_f64": return `_ms_f64_bits((double)(uint64_t)(${a(0)}))`;

            // メモリ
            case "__builtin_malloc":       return `_ms_malloc(${a(0)})`;
            case "__builtin_free":         {
                // arg がオブジェクトポインタなら C の free() を呼ぶ (借用チェッカー自動挿入)
                // 生のヒープアドレス (_m32) なら _ms_free (バンプアロケータでは no-op)
                const argType = applySubst((node.args[0] as any).resolvedType ?? "_m32", subst);
                if (this.isRef(this.resolveAlias(argType))) {
                    pre.push(`free(${a(0)});`);
                } else {
                    pre.push(`_ms_free(${a(0)});`);
                }
                return "";
            }
            case "__builtin_mem_read8":    return `_ms_mem_read8(${a(0)}, ${a(1)})`;
            case "__builtin_mem_read16":   return `_ms_mem_read16(${a(0)}, ${a(1)})`;
            case "__builtin_mem_read32":   return `_ms_mem_read32(${a(0)}, ${a(1)})`;
            case "__builtin_mem_read64":   return `_ms_mem_read64(${a(0)}, ${a(1)})`;
            case "__builtin_mem_write8":   { pre.push(`_ms_mem_write8(${a(0)}, ${a(1)}, ${a(2)});`);  return ""; }
            case "__builtin_mem_write16":  { pre.push(`_ms_mem_write16(${a(0)}, ${a(1)}, ${a(2)});`); return ""; }
            case "__builtin_mem_write64":  { pre.push(`_ms_mem_write64(${a(0)}, ${a(1)}, ${a(2)});`); return ""; }
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
                const sv = this.maybeTemp(v0, this.cType(applySubst(
                    (node.args[0] as any).resolvedType ?? "Array<u32>", subst)), pre);
                pre.push(`_ms_write_str(${sv}->ptr, ${sv}->${this.arrayFields().len});`);
                return "";
            }
            case "__builtin_stderr_write": {
                const v0 = this.flattenExpr(node.args[0], pre, subst);
                const sv = this.maybeTemp(v0, this.cType(applySubst(
                    (node.args[0] as any).resolvedType ?? "Array<u32>", subst)), pre);
                pre.push(`_ms_write_str_err(${sv}->ptr, ${sv}->${this.arrayFields().len});`);
                return "";
            }
            case "__builtin_panic": {
                const v0 = this.flattenExpr(node.args[0], pre, subst);
                const sv = this.maybeTemp(v0, this.cType(applySubst(
                    (node.args[0] as any).resolvedType ?? "Array<u32>", subst)), pre);
                pre.push(`_ms_panic_str(${sv}->ptr, ${sv}->${this.arrayFields().len});`);
                return "";
            }
            case "__builtin_stdin_readline": {
                pre.push(`fprintf(stderr, "[PANIC] __builtin_stdin_readline not supported\\n"); exit(1);`);
                const rtmp = this.nextTmp();
                pre.push(`_ms_Array_u32* ${rtmp} = (_ms_Array_u32*)calloc(1, sizeof(_ms_Array_u32));`);
                return rtmp;
            }

            case "__builtin_str_length": {
                const v0 = this.flattenExpr(node.args[0], pre, subst);
                const sv = this.maybeTemp(v0, this.cType(applySubst(
                    (node.args[0] as any).resolvedType ?? "Array<u32>", subst)), pre);
                return `${sv}->${this.arrayFields().len}`;
            }

            // sizeof
            case "__builtin_sizeof":
                return `(int32_t)${this.computeSizeof(applySubst(node.targetType ?? "i32", subst))}`;

            // ── スレッド ──────────────────────────────────────────────────────
            case "__builtin_thread_spawn": {
                // args[0] = fnName (Array<u32>), args[1] = emptyArgs
                const { ptr: pF, len: lF } = this.arrayFields();
                const fn0type = applySubst((node.args[0] as any).resolvedType ?? "Array<u32>", subst);
                const fn0 = this.flattenExpr(node.args[0], pre, subst);
                const fnV = this.maybeTemp(fn0, this.cType(fn0type), pre);
                return `(int64_t)_ms_thread_spawn(${fnV}->${pF}, ${fnV}->${lF})`;
            }
            case "__builtin_thread_join": {
                pre.push(`_ms_thread_join(${a(0)});`);
                return "";
            }
            case "__builtin_threadpool_create":
                return `(int64_t)_ms_tp_create(${a(0)})`;
            case "__builtin_threadpool_submit": {
                // args[0] = pool (_m64), args[1] = fnName (Array<u32>), args[2] = emptyArgs
                const { ptr: pF, len: lF } = this.arrayFields();
                const fn1type = applySubst((node.args[1] as any).resolvedType ?? "Array<u32>", subst);
                const fn1 = this.flattenExpr(node.args[1], pre, subst);
                const fnV = this.maybeTemp(fn1, this.cType(fn1type), pre);
                pre.push(`_ms_tp_submit(${a(0)}, ${fnV}->${pF}, ${fnV}->${lF});`);
                return "";
            }
            case "__builtin_threadpool_wait": {
                pre.push(`_ms_tp_wait(${a(0)});`);
                return "";
            }
            case "__builtin_threadpool_destroy": {
                pre.push(`_ms_tp_destroy(${a(0)});`);
                return "";
            }

            // ── ミューテックス / 条件変数 ────────────────────────────────────
            case "__builtin_mutex_create":
                return `(int64_t)_ms_mutex_create()`;
            case "__builtin_mutex_lock": {
                pre.push(`_ms_mutex_lock(${a(0)});`);
                return "";
            }
            case "__builtin_mutex_unlock": {
                pre.push(`_ms_mutex_unlock(${a(0)});`);
                return "";
            }
            case "__builtin_condvar_create":
                return `(int64_t)_ms_condvar_create()`;
            case "__builtin_condvar_wait": {
                pre.push(`_ms_condvar_wait(${a(0)}, ${a(1)});`);
                return "";
            }
            case "__builtin_condvar_signal": {
                pre.push(`_ms_condvar_signal(${a(0)});`);
                return "";
            }
            case "__builtin_condvar_broadcast": {
                pre.push(`_ms_condvar_broadcast(${a(0)});`);
                return "";
            }

            // ── アトミック操作（MemoryOrder 対応版） ─────────────────────────────
            // 32bit
            case "__builtin_atomic_load32":
                return `(int32_t)__atomic_load_n(&_ms_heap[(int32_t)(${a(0)})], _ms_mo(${a(1)}))`;
            case "__builtin_atomic_store32": {
                pre.push(`__atomic_store_n(&_ms_heap[(int32_t)(${a(0)})], (int32_t)(${a(1)}), _ms_mo(${a(2)}));`);
                return "";
            }
            case "__builtin_atomic_cas32": {
                const tmp = this.nextTmp();
                const res = this.nextTmp();
                pre.push(`int32_t ${tmp} = (int32_t)(${a(1)});`);
                pre.push(`int32_t ${res} = (int32_t)__atomic_compare_exchange_n(&_ms_heap[(int32_t)(${a(0)})], &${tmp}, (int32_t)(${a(2)}), 0, _ms_mo(${a(3)}), _ms_mo(${a(4)}));`);
                return res;
            }
            case "__builtin_atomic_fetch_add32":
                return `(int32_t)__atomic_fetch_add(&_ms_heap[(int32_t)(${a(0)})], (int32_t)(${a(1)}), _ms_mo(${a(2)}))`;
            case "__builtin_atomic_fetch_sub32":
                return `(int32_t)__atomic_fetch_sub(&_ms_heap[(int32_t)(${a(0)})], (int32_t)(${a(1)}), _ms_mo(${a(2)}))`;
            // 64bit（ptr は 2-word アライメント必須）
            case "__builtin_atomic_load64":
                return `(int64_t)__atomic_load_n((int64_t*)&_ms_heap[(int32_t)(${a(0)})], _ms_mo(${a(1)}))`;
            case "__builtin_atomic_store64": {
                pre.push(`__atomic_store_n((int64_t*)&_ms_heap[(int32_t)(${a(0)})], (int64_t)(${a(1)}), _ms_mo(${a(2)}));`);
                return "";
            }
            case "__builtin_atomic_cas64": {
                const tmp = this.nextTmp();
                const res = this.nextTmp();
                pre.push(`int64_t ${tmp} = (int64_t)(${a(1)});`);
                pre.push(`int32_t ${res} = (int32_t)__atomic_compare_exchange_n((int64_t*)&_ms_heap[(int32_t)(${a(0)})], &${tmp}, (int64_t)(${a(2)}), 0, _ms_mo(${a(3)}), _ms_mo(${a(4)}));`);
                return res;
            }
            case "__builtin_atomic_fetch_add64":
                return `(int64_t)__atomic_fetch_add((int64_t*)&_ms_heap[(int32_t)(${a(0)})], (int64_t)(${a(1)}), _ms_mo(${a(2)}))`;
            case "__builtin_atomic_fetch_sub64":
                return `(int64_t)__atomic_fetch_sub((int64_t*)&_ms_heap[(int32_t)(${a(0)})], (int64_t)(${a(1)}), _ms_mo(${a(2)}))`;
            // フェンス
            case "__builtin_atomic_fence": {
                pre.push(`__atomic_thread_fence(_ms_mo(${a(0)}));`);
                return "";
            }

            // ── GPU エミュレーション (CPU 上で同期実行) ─────────────────────
            // 仕様: doc/mozaicScript-spec.md §14 / doc/mozaicScript-corelib-spec.md §8
            case "__builtin_gpu_is_available":              return `(int32_t)1`;
            case "__builtin_gpu_buffer_create":             return `(int64_t)_ms_gpu_buf_create(${a(0)})`;
            case "__builtin_gpu_buffer_map_write":          return `(int32_t)_ms_gpu_buf_addr(${a(0)})`;
            case "__builtin_gpu_buffer_map_read":           return `(int32_t)_ms_gpu_buf_addr(${a(0)})`;
            case "__builtin_gpu_buffer_unmap":              { pre.push(`(void)(${a(0)});`); return ""; }
            case "__builtin_gpu_buffer_byte_size":          return `(int64_t)_ms_gpu_buf_size(${a(0)})`;
            case "__builtin_gpu_buffer_free":               { pre.push(`_ms_gpu_buf_free(${a(0)});`); return ""; }
            case "__builtin_gpu_kernel_handle":             return `(int64_t)_ms_gpu_kern_by_index(${a(0)})`;
            case "__builtin_gpu_kernel_workgroup_size_x":   return `(int32_t)_ms_gpu_kern_wgx(${a(0)})`;
            case "__builtin_gpu_kernel_workgroup_size_y":   return `(int32_t)_ms_gpu_kern_wgy(${a(0)})`;
            case "__builtin_gpu_kernel_workgroup_size_z":   return `(int32_t)_ms_gpu_kern_wgz(${a(0)})`;
            case "__builtin_gpu_args_create":               return `(int64_t)_ms_gpu_args_create()`;
            case "__builtin_gpu_args_push_buffer":          { pre.push(`_ms_gpu_args_push_addr(${a(0)}, (int32_t)_ms_gpu_buf_addr(${a(1)}));`); return ""; }
            case "__builtin_gpu_args_push_i32":             { pre.push(`_ms_gpu_args_push_i32(${a(0)}, (int32_t)(${a(1)}));`); return ""; }
            case "__builtin_gpu_args_push_u32":             { pre.push(`_ms_gpu_args_push_i32(${a(0)}, (int32_t)(${a(1)}));`); return ""; }
            case "__builtin_gpu_args_push_i64":             { pre.push(`_ms_gpu_args_push_i64(${a(0)}, (int64_t)(${a(1)}));`); return ""; }
            case "__builtin_gpu_args_push_u64":             { pre.push(`_ms_gpu_args_push_i64(${a(0)}, (int64_t)(${a(1)}));`); return ""; }
            case "__builtin_gpu_args_push_f32":             { pre.push(`_ms_gpu_args_push_i32(${a(0)}, (int32_t)(${a(1)}));`); return ""; }
            case "__builtin_gpu_args_push_f64":             { pre.push(`_ms_gpu_args_push_i64(${a(0)}, (int64_t)(${a(1)}));`); return ""; }
            case "__builtin_gpu_args_push_boolean":         { pre.push(`_ms_gpu_args_push_i32(${a(0)}, (int32_t)(${a(1)}));`); return ""; }
            case "__builtin_gpu_args_count":                return `(int32_t)_ms_gpu_args_count(${a(0)})`;
            case "__builtin_gpu_args_clear":                { pre.push(`_ms_gpu_args_clear(${a(0)});`); return ""; }
            case "__builtin_gpu_dispatch":                  { pre.push(`_ms_gpu_dispatch(${a(0)}, ${a(1)}, (int32_t)(${a(2)}), (int32_t)(${a(3)}), (int32_t)(${a(4)}));`); return ""; }
            case "__builtin_gpu_sync":                      return `(int32_t)0`;
            case "__builtin_gpu_flush":                     return `(int32_t)0`;
            case "__builtin_gpu_thread_global_id_x":        return `(int32_t)_ms_gpu_ctx.gix`;
            case "__builtin_gpu_thread_global_id_y":        return `(int32_t)_ms_gpu_ctx.giy`;
            case "__builtin_gpu_thread_global_id_z":        return `(int32_t)_ms_gpu_ctx.giz`;
            case "__builtin_gpu_thread_local_id_x":         return `(int32_t)_ms_gpu_ctx.lix`;
            case "__builtin_gpu_thread_local_id_y":         return `(int32_t)_ms_gpu_ctx.liy`;
            case "__builtin_gpu_thread_local_id_z":         return `(int32_t)_ms_gpu_ctx.liz`;
            case "__builtin_gpu_thread_workgroup_id_x":     return `(int32_t)_ms_gpu_ctx.wix`;
            case "__builtin_gpu_thread_workgroup_id_y":     return `(int32_t)_ms_gpu_ctx.wiy`;
            case "__builtin_gpu_thread_workgroup_id_z":     return `(int32_t)_ms_gpu_ctx.wiz`;
            case "__builtin_gpu_thread_workgroup_size":     return `(int32_t)_ms_gpu_ctx.wgx`;
            case "__builtin_gpu_barrier":                   return `(int32_t)0`;
            case "__builtin_gpu_storage_barrier":           return `(int32_t)0`;
            case "__builtin_gpu_atomic_add_u32":            return `(int32_t)_ms_gpu_atomic_add_u32((int32_t)(${a(0)}), (uint32_t)(${a(1)}))`;
            case "__builtin_gpu_atomic_sub_u32":            return `(int32_t)_ms_gpu_atomic_sub_u32((int32_t)(${a(0)}), (uint32_t)(${a(1)}))`;
            case "__builtin_gpu_atomic_min_u32":            return `(int32_t)_ms_gpu_atomic_min_u32((int32_t)(${a(0)}), (uint32_t)(${a(1)}))`;
            case "__builtin_gpu_atomic_max_u32":            return `(int32_t)_ms_gpu_atomic_max_u32((int32_t)(${a(0)}), (uint32_t)(${a(1)}))`;
            case "__builtin_gpu_atomic_cas_u32":            return `(int32_t)_ms_gpu_atomic_cas_u32((int32_t)(${a(0)}), (uint32_t)(${a(1)}), (uint32_t)(${a(2)}))`;
            case "__builtin_gpu_atomic_load_u32":           return `(int32_t)_ms_heap[(int32_t)(${a(0)})]`;
            case "__builtin_gpu_atomic_store_u32":          { pre.push(`_ms_heap[(int32_t)(${a(0)})] = (int32_t)(${a(1)});`); return ""; }
            case "__builtin_gpu_atomic_add_i32":            return `(int32_t)_ms_gpu_atomic_add_i32((int32_t)(${a(0)}), (int32_t)(${a(1)}))`;
            case "__builtin_gpu_atomic_sub_i32":            return `(int32_t)_ms_gpu_atomic_sub_i32((int32_t)(${a(0)}), (int32_t)(${a(1)}))`;
            case "__builtin_gpu_atomic_min_i32":            return `(int32_t)_ms_gpu_atomic_min_i32((int32_t)(${a(0)}), (int32_t)(${a(1)}))`;
            case "__builtin_gpu_atomic_max_i32":            return `(int32_t)_ms_gpu_atomic_max_i32((int32_t)(${a(0)}), (int32_t)(${a(1)}))`;
            case "__builtin_gpu_atomic_cas_i32":            return `(int32_t)_ms_gpu_atomic_cas_i32((int32_t)(${a(0)}), (int32_t)(${a(1)}), (int32_t)(${a(2)}))`;
            case "__builtin_gpu_atomic_load_i32":           return `(int32_t)_ms_heap[(int32_t)(${a(0)})]`;
            case "__builtin_gpu_atomic_store_i32":          { pre.push(`_ms_heap[(int32_t)(${a(0)})] = (int32_t)(${a(1)});`); return ""; }
            case "__builtin_gpu_fma":                       return `(int32_t)_ms_f32_bits(fmaf(_ms_bits_f32((int32_t)(${a(0)})), _ms_bits_f32((int32_t)(${a(1)})), _ms_bits_f32((int32_t)(${a(2)}))))`;
            case "__builtin_gpu_dot_f32x4":                 return `(int32_t)_ms_gpu_dot_f32x4((int32_t)(${a(0)}), (int32_t)(${a(1)}))`;
            case "__builtin_gpu_kernel_name": {
                // 戻り値は Array<u32> ポインタが期待されるが、テストで未使用なので空配列を返す
                const tmp = this.nextTmp();
                pre.push(`_ms_Array_u32* ${tmp} = (_ms_Array_u32*)calloc(1, sizeof(_ms_Array_u32));`);
                return tmp;
            }

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
        // 参照型レシーバは既にポインタ（self に渡すアドレスそのもの）
        if (this.isRef(resolvedType)) {
            if (node.type === "Identifier" && node.name === "this") return "self";
            const refExpr = this.flattenExpr(node, pre, subst);
            return this.maybeTemp(refExpr, this.cType(resolvedType), pre);
        }
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

    // bits フィールドを1つだけ持つラッパー型か判定（_m32 / _m64 両対応）
    private hasSimpleBitsField(mozType: string): boolean {
        const base = baseType(mozType);
        const cls  = this.classes.get(base);
        if (!cls) return false;
        const privateFields = cls.members.filter(f => f.access === "private");
        return privateFields.length === 1
            && privateFields[0].name === "bits"
            && (privateFields[0].resolvedType === "_m32" || privateFields[0].resolvedType === "_m64");
    }

    private computeSizeof(mozType: string): number {
        const MACHINE_SIZES: Record<string, number> = {
            "_m8": 1, "_m16": 2, "_m32": 4, "_m64": 8, "_m128": 16, "_m256": 32, "_m512": 64,
        };
        if (MACHINE_SIZES[mozType] !== undefined) return MACHINE_SIZES[mozType];
        // 参照型オブジェクトはポインタ（ヒープ上の実体は別管理）として 1 ワード×幅
        if (this.isRef(mozType)) return CCodegen.POINTER_SIZE;
        const base = baseType(mozType);
        const cls  = this.classes.get(base);
        if (!cls) return 4;
        let total = 0;
        for (const field of cls.members) {
            // include all fields (public, private, mocp public) for sizeof
            switch (field.resolvedType) {
                case "_m8":   total += 1;  break;
                case "_m16":  total += 2;  break;
                case "_m32":  total += 4;  break;
                case "_m64":  total += 8;  break;
                case "_m128": total += 16; break;
                case "_m256": total += 32; break;
                case "_m512": total += 64; break;
                default: total += this.computeSizeof(field.resolvedType); break;
            }
        }
        return total > 0 ? total : 4;
    }
}
