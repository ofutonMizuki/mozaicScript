// jscodegen/codegen.ts — mozaicScript IR → JavaScript コードジェネレータ
//
// 設計方針:
//   - プリミティブラッパークラス (i32, u32, f32, boolean 等) → JS の bare number
//   - オブジェクト型 → plain JS object { field: 0, ... }
//   - __builtin_XXX → 直接 JS 算術式にインライン展開
//   - ジェネリッククラスは具体型ごとに関数を生成

import * as fs from "fs";
import * as nodePath from "path";
import { ASTNode, ClassDecl, FunctionDecl, MozaicScriptAST } from "../interpreter/types";

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
        else if (inner[i] === "," && depth === 0) {
            res.push(inner.slice(start, i).trim());
            start = i + 1;
        }
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

// ── プリミティブコーション ─────────────────────────────────────────────────────

function coerce(expr: string, bitsType: string): string {
    switch (bitsType) {
        case "_m8":  return `((${expr})&0xFF)`;
        case "_m16": return `((${expr})&0xFFFF)`;
        case "_m32": return `((${expr})|0)`;
        case "_m64": return `(+(${expr}))`;
        default:     return expr;
    }
}

// ── インスタンス名マングル ─────────────────────────────────────────────────────

const OP_MAP: Record<string, string> = {
    "operator+":      "op_add",
    "operator-":      "op_sub",
    "operator*":      "op_mul",
    "operator/":      "op_div",
    "operator%":      "op_mod",
    "operator==":     "op_eq",
    "operator<":      "op_lt",
    "operator>":      "op_gt",
    "operator||":     "op_or",
    "operator&&":     "op_and",
    "operatorNot":    "op_not",
    "operator[]":     "op_idx_get",
    "operator_set[]": "op_idx_set",
    "constructor":    "ctor",
};

function mangleName(s: string): string {
    return s.replace(/[^a-zA-Z0-9_]/g, "_");
}

function jsFnName(mozType: string, method: string): string {
    const m = OP_MAP[method] ?? method;
    const base = baseType(mozType);
    const args = typeArgs(mozType);
    const suffix = args.length > 0 ? "_" + args.map(a => mangleName(baseType(a))).join("_") : "";
    return `_ms_${mangleName(base)}${suffix}__${m}`;
}

function jsTopFnName(name: string, concreteT?: string): string {
    return concreteT ? `_top_${name}__${mangleName(baseType(concreteT))}` : `_top_${name}`;
}

// ── Intrinsic → JS 式テンプレート ────────────────────────────────────────────

const INTRINSIC_JS: Record<string, (...args: string[]) => string> = {
    // i32
    "__builtin_i32_add": (a, b) => `((${a}+${b})|0)`,
    "__builtin_i32_sub": (a, b) => `((${a}-${b})|0)`,
    "__builtin_i32_mul": (a, b) => `(Math.imul(${a},${b}))`,
    "__builtin_i32_div": (a, b) => `((${a}/${b})|0)`,
    "__builtin_i32_mod": (a, b) => `((${a}%${b})|0)`,
    "__builtin_i32_neg": (a)    => `((-${a})|0)`,
    "__builtin_i32_eq":  (a, b) => `(${a}===${b}?1:0)`,
    "__builtin_i32_lt":  (a, b) => `(${a}<${b}?1:0)`,
    "__builtin_i32_gt":  (a, b) => `(${a}>${b}?1:0)`,
    "__builtin_i32_or":  (a, b) => `(${a}|${b})`,
    "__builtin_i32_and": (a, b) => `(${a}&${b})`,
    "__builtin_i32_not": (a)    => `(${a}===0?1:0)`,
    "__builtin_i32_shl": (a, b) => `(${a}<<${b})`,
    "__builtin_i32_shr": (a, b) => `(${a}>>${b})`,
    "__builtin_i32_rotl": (a, b) => `(((${a}<<((${b})&31))|(${a}>>>((32-(${b}))&31)))|0)`,
    "__builtin_i32_rotr": (a, b) => `(((${a}>>>((${b})&31))|(${a}<<((32-(${b}))&31)))|0)`,
    "__builtin_i32_clz":    (a) => `Math.clz32(${a})`,
    "__builtin_i32_ctz":    (a) => `((${a}|0)===0?32:(31-Math.clz32((${a})&-(${a}))))`,
    "__builtin_i32_popcnt": (a) => `(()=>{let _x=(${a})>>>0;_x=_x-(_x>>>1&0x55555555);_x=(_x&0x33333333)+((_x>>>2)&0x33333333);_x=((_x+(_x>>>4))&0x0f0f0f0f);return((_x*0x01010101)>>>24)|0;})()`,

    // u32
    "__builtin_u32_add": (a, b) => `((${a}+${b})>>>0)`,
    "__builtin_u32_sub": (a, b) => `((${a}-${b})>>>0)`,
    "__builtin_u32_mul": (a, b) => `((Math.imul(${a},${b}))>>>0)`,
    "__builtin_u32_div": (a, b) => `(((${a})>>>0)/((${b})>>>0)>>>0)`,
    "__builtin_u32_mod": (a, b) => `(((${a})>>>0)%((${b})>>>0)>>>0)`,
    "__builtin_u32_eq":  (a, b) => `((${a})>>>=0,(${b})>>>=0,${a}===${b}?1:0)`,
    "__builtin_u32_lt":  (a, b) => `(((${a})>>>0)<((${b})>>>0)?1:0)`,
    "__builtin_u32_gt":  (a, b) => `(((${a})>>>0)>((${b})>>>0)?1:0)`,
    "__builtin_u32_or":  (a, b) => `((${a}|${b})>>>0)`,
    "__builtin_u32_and": (a, b) => `((${a}&${b})>>>0)`,
    "__builtin_u32_shl": (a, b) => `(((${a})>>>0)<<(${b}))`,
    "__builtin_u32_shr": (a, b) => `(((${a})>>>0)>>>(${b}))`,

    // f32
    "__builtin_f32_add":     (a, b) => `Math.fround((${a})+(${b}))`,
    "__builtin_f32_sub":     (a, b) => `Math.fround((${a})-(${b}))`,
    "__builtin_f32_mul":     (a, b) => `Math.fround((${a})*(${b}))`,
    "__builtin_f32_div":     (a, b) => `Math.fround((${a})/(${b}))`,
    "__builtin_f32_mod":     (a, b) => `Math.fround((${a})%(${b}))`,
    "__builtin_f32_neg":     (a)    => `Math.fround(-(${a}))`,
    "__builtin_f32_eq":      (a, b) => `((${a})===(${b})?1:0)`,
    "__builtin_f32_lt":      (a, b) => `((${a})<(${b})?1:0)`,
    "__builtin_f32_gt":      (a, b) => `((${a})>(${b})?1:0)`,
    "__builtin_f32_abs":     (a) => `Math.fround(Math.abs(${a}))`,
    "__builtin_f32_sqrt":    (a) => `Math.fround(Math.sqrt(${a}))`,
    "__builtin_f32_floor":   (a) => `Math.fround(Math.floor(${a}))`,
    "__builtin_f32_ceil":    (a) => `Math.fround(Math.ceil(${a}))`,
    "__builtin_f32_trunc":   (a) => `Math.fround(Math.trunc(${a}))`,
    "__builtin_f32_nearest": (a) => `Math.fround(Math.round(${a}))`,
    "__builtin_f32_min":     (a, b) => `Math.fround(Math.min(${a},${b}))`,
    "__builtin_f32_max":     (a, b) => `Math.fround(Math.max(${a},${b}))`,
    "__builtin_f32_sin":     (a) => `Math.fround(Math.sin(${a}))`,
    "__builtin_f32_cos":     (a) => `Math.fround(Math.cos(${a}))`,
    "__builtin_f32_tan":     (a) => `Math.fround(Math.tan(${a}))`,
    "__builtin_f32_exp":     (a) => `Math.fround(Math.exp(${a}))`,
    "__builtin_f32_log":     (a) => `Math.fround(Math.log(${a}))`,
    "__builtin_f32_pow":     (a, b) => `Math.fround(Math.pow(${a},${b}))`,
    "__builtin_f32_atan":    (a) => `Math.fround(Math.atan(${a}))`,
    "__builtin_f32_atan2":   (a, b) => `Math.fround(Math.atan2(${a},${b}))`,

    // f64
    "__builtin_f64_add":     (a, b) => `((${a})+(${b}))`,
    "__builtin_f64_sub":     (a, b) => `((${a})-(${b}))`,
    "__builtin_f64_mul":     (a, b) => `((${a})*(${b}))`,
    "__builtin_f64_div":     (a, b) => `((${a})/(${b}))`,
    "__builtin_f64_mod":     (a, b) => `((${a})%(${b}))`,
    "__builtin_f64_neg":     (a)    => `(-(${a}))`,
    "__builtin_f64_eq":      (a, b) => `((${a})===(${b})?1:0)`,
    "__builtin_f64_lt":      (a, b) => `((${a})<(${b})?1:0)`,
    "__builtin_f64_gt":      (a, b) => `((${a})>(${b})?1:0)`,
    "__builtin_f64_abs":     (a) => `Math.abs(${a})`,
    "__builtin_f64_sqrt":    (a) => `Math.sqrt(${a})`,
    "__builtin_f64_floor":   (a) => `Math.floor(${a})`,
    "__builtin_f64_ceil":    (a) => `Math.ceil(${a})`,
    "__builtin_f64_trunc":   (a) => `Math.trunc(${a})`,
    "__builtin_f64_nearest": (a) => `Math.round(${a})`,
    "__builtin_f64_min":     (a, b) => `Math.min(${a},${b})`,
    "__builtin_f64_max":     (a, b) => `Math.max(${a},${b})`,
    "__builtin_f64_sin":     (a) => `Math.sin(${a})`,
    "__builtin_f64_cos":     (a) => `Math.cos(${a})`,
    "__builtin_f64_tan":     (a) => `Math.tan(${a})`,
    "__builtin_f64_exp":     (a) => `Math.exp(${a})`,
    "__builtin_f64_log":     (a) => `Math.log(${a})`,
    "__builtin_f64_pow":     (a, b) => `Math.pow(${a},${b})`,
    "__builtin_f64_atan":    (a) => `Math.atan(${a})`,
    "__builtin_f64_atan2":   (a, b) => `Math.atan2(${a},${b})`,

    // i64 / u64 (number で近似、精度は落ちるが動作優先)
    "__builtin_i64_add": (a, b) => `((${a})+(${b}))`,
    "__builtin_i64_sub": (a, b) => `((${a})-(${b}))`,
    "__builtin_i64_mul": (a, b) => `((${a})*(${b}))`,
    "__builtin_i64_div": (a, b) => `Math.trunc((${a})/(${b}))`,
    "__builtin_i64_mod": (a, b) => `((${a})%(${b}))`,
    "__builtin_i64_neg": (a)    => `(-(${a}))`,
    "__builtin_i64_eq":  (a, b) => `((${a})===(${b})?1:0)`,
    "__builtin_i64_lt":  (a, b) => `((${a})<(${b})?1:0)`,
    "__builtin_i64_gt":  (a, b) => `((${a})>(${b})?1:0)`,
    "__builtin_i64_or":  (a, b) => `((${a})|(${b}))`,
    "__builtin_i64_and": (a, b) => `((${a})&(${b}))`,
    "__builtin_i64_not": (a)    => `((${a})===0?1:0)`,
    "__builtin_i64_shl": (a, b) => `((${a})<<(${b}))`,
    "__builtin_i64_shr": (a, b) => `((${a})>>(${b}))`,
    "__builtin_i64_clz":    (a)    => `Math.clz32(${a})`,
    "__builtin_i64_ctz":    (a)    => `((${a}|0)===0?32:Math.clz32((${a})&-(${a})))`,
    "__builtin_i64_popcnt": (a)    => `(()=>{let n=${a}|0,c=0;while(n){c+=n&1;n>>>=1;}return c;})()`,
    "__builtin_i64_rotl":   (a, b) => `(((${a})<<(${b}))|((${a})>>>(32-(${b}))))`,
    "__builtin_u64_shl":    (a, b) => `((${a})<<(${b}))`,
    "__builtin_u64_shr":    (a, b) => `((${a})>>>(${b}))`,
    "__builtin_u64_add": (a, b) => `((${a})+(${b}))`,
    "__builtin_u64_sub": (a, b) => `((${a})-(${b}))`,
    "__builtin_u64_mul": (a, b) => `((${a})*(${b}))`,
    "__builtin_u64_div": (a, b) => `Math.trunc((${a})/(${b}))`,
    "__builtin_u64_mod": (a, b) => `((${a})%(${b}))`,
    "__builtin_u64_eq":  (a, b) => `((${a})===(${b})?1:0)`,
    "__builtin_u64_lt":  (a, b) => `((${a})<(${b})?1:0)`,
    "__builtin_u64_gt":  (a, b) => `((${a})>(${b})?1:0)`,
    "__builtin_u64_or":  (a, b) => `((${a})|(${b}))`,
    "__builtin_u64_and": (a, b) => `((${a})&(${b}))`,
    "__builtin_u64_not": (a)    => `((${a})===0?1:0)`,

    // 型変換
    "__builtin_i32_to_f32": (a) => `Math.fround((${a})|0)`,
    "__builtin_i32_to_u32": (a) => `(((${a})|0)>>>0)`,
    "__builtin_u32_to_f32": (a) => `Math.fround((${a})>>>0)`,
    "__builtin_u32_to_i32": (a) => `(((${a})>>>0)|0)`,
    "__builtin_f32_to_i32": (a) => `(Math.trunc(${a})|0)`,
    "__builtin_f32_to_u32": (a) => `(Math.trunc(${a})>>>0)`,
    "__builtin_i32_to_i64": (a) => `((${a})|0)`,
    "__builtin_u32_to_u64": (a) => `((${a})>>>0)`,
    "__builtin_i64_to_i32": (a) => `((${a})|0)`,
    "__builtin_u64_to_u32": (a) => `((${a})>>>0)`,
    "__builtin_f32_to_f64": (a) => `Math.fround(${a})`,
    "__builtin_f64_to_f32": (a) => `Math.fround(${a})`,
    "__builtin_i32_to_f64": (a) => `((${a})|0)`,
    "__builtin_u32_to_f64": (a) => `((${a})>>>0)`,
    "__builtin_f64_to_i64": (a) => `Math.trunc(${a})`,
    "__builtin_i64_to_f64": (a) => `(${a})`,
    "__builtin_u64_to_f64": (a) => `(${a})`,

    // メモリ (word-addressed Int32Array)
    "__builtin_malloc":      (n) => `_ms_malloc(${n})`,
    "__builtin_free":        (p) => `(_ms_free(${p}),0)`,
    "__builtin_zeroinit":    ()  => `0`,
    "__builtin_mem_read8":   (p, o) => `(_ms_heap[((${p}|0)+(((${o})|0)>>2))|0]&0xFF)`,
    "__builtin_mem_read16":  (p, o) => `(_ms_heap[((${p}|0)+(((${o})|0)>>2))|0]&0xFFFF)`,
    "__builtin_mem_read32":  (p, o) => `(_ms_heap[((${p}|0)+(((${o})|0)>>2))|0])`,
    "__builtin_mem_read64":  (p, o) => `(_ms_heap[((${p}|0)+(((${o})|0)>>2))|0])`,
    "__builtin_mem_write8":  (p, o, v) => `(_ms_heap[((${p}|0)+(((${o})|0)>>2))|0]=(${v})|0,0)`,
    "__builtin_mem_write16": (p, o, v) => `(_ms_heap[((${p}|0)+(((${o})|0)>>2))|0]=(${v})|0,0)`,
    "__builtin_mem_write32": (p, o, v) => `(_ms_heap[((${p}|0)+(((${o})|0)>>2))|0]=(${v})|0,0)`,
    "__builtin_mem_write64": (p, o, v) => `(_ms_heap[((${p}|0)+(((${o})|0)>>2))|0]=(${v})|0,0)`,

    // I/O
    "__builtin_stdout_write":   (s) => `_ms_stdout_write(${s})`,
    "__builtin_stderr_write":   (s) => `_ms_stderr_write(${s})`,
    "__builtin_stdin_readline": ()  => `""`,

    // パニック
    "__builtin_panic": (s) => `_ms_panic(${s})`,

    // アトミック (シングルスレッド近似) — order はシングルスレッドのため無視
    // 32bit
    "__builtin_atomic_load32":      (p, _o)             => `(_ms_heap[(${p}|0)])`,
    "__builtin_atomic_store32":     (p, v, _o)          => `(_ms_heap[(${p}|0)]=(${v})|0,0)`,
    "__builtin_atomic_cas32":       (p, e, d, _so, _fo) => `(_ms_heap[(${p}|0)]===(${e})|0?(_ms_heap[(${p}|0)]=(${d})|0,1):0)`,
    "__builtin_atomic_fetch_add32": (p, v, _o)          => `(()=>{const _a=(${p})|0;const _c=_ms_heap[_a];_ms_heap[_a]=(_c+(${v}))|0;return _c;})()`,
    "__builtin_atomic_fetch_sub32": (p, v, _o)          => `(()=>{const _a=(${p})|0;const _c=_ms_heap[_a];_ms_heap[_a]=(_c-(${v}))|0;return _c;})()`,
    // 64bit — JS は i64 を number で近似
    "__builtin_atomic_load64":      (p, _o)             => `(_ms_heap[(${p}|0)])`,
    "__builtin_atomic_store64":     (p, v, _o)          => `(_ms_heap[(${p}|0)]=(${v}),0)`,
    "__builtin_atomic_cas64":       (p, e, d, _so, _fo) => `(_ms_heap[(${p}|0)]===(${e})?(_ms_heap[(${p}|0)]=(${d}),1):0)`,
    "__builtin_atomic_fetch_add64": (p, v, _o)          => `(()=>{const _a=(${p})|0;const _c=_ms_heap[_a];_ms_heap[_a]=_c+(${v});return _c;})()`,
    "__builtin_atomic_fetch_sub64": (p, v, _o)          => `(()=>{const _a=(${p})|0;const _c=_ms_heap[_a];_ms_heap[_a]=_c-(${v});return _c;})()`,
    // フェンス — no-op
    "__builtin_atomic_fence": (_o) => `(0)`,
    // mutex / condvar は no-op
    "__builtin_mutex_create":      () => `0`,
    "__builtin_mutex_lock":        () => `0`,
    "__builtin_mutex_unlock":      () => `0`,
    "__builtin_condvar_create":    () => `0`,
    "__builtin_condvar_wait":      () => `0`,
    "__builtin_condvar_signal":    () => `0`,
    "__builtin_condvar_broadcast": () => `0`,
    // thread / threadpool (single-threaded stubs)
    "__builtin_thread_spawn":          (fn, args) => `(_ms_thread_spawn(${fn},${args}))`,
    "__builtin_thread_join":           (id)        => `(_ms_thread_join(${id}),0)`,
    "__builtin_threadpool_create":     (sz)        => `(_ms_tp_create(${sz}))`,
    "__builtin_threadpool_submit":     (p, fn, a)  => `(_ms_tp_submit(${p},${fn},${a}),0)`,
    "__builtin_threadpool_wait":       (p)         => `(_ms_tp_wait(${p}),0)`,
    "__builtin_threadpool_destroy":    (p)         => `(_ms_tp_destroy(${p}),0)`,
    // ── GPU エミュレーション (CPU 同期実行) ──
    "__builtin_gpu_is_available":        () => `1`,
    "__builtin_gpu_buffer_create":       (s)    => `(_ms_gpu_buf_create(${s}))`,
    "__builtin_gpu_buffer_map_write":    (h)    => `(_ms_gpu_buf_addr(${h}))`,
    "__builtin_gpu_buffer_map_read":     (h)    => `(_ms_gpu_buf_addr(${h}))`,
    "__builtin_gpu_buffer_unmap":        (_h)   => `(0)`,
    "__builtin_gpu_buffer_byte_size":    (h)    => `(_ms_gpu_buf_size(${h}))`,
    "__builtin_gpu_buffer_free":         (h)    => `(_ms_gpu_buf_free(${h}),0)`,
    // 文字列を返す kernel_name はテストで未使用のため runtime stub のみ提供
    "__builtin_gpu_kernel_name":             (_h) => `(_ms_gpu_kern_name(${_h}))`,
    "__builtin_gpu_kernel_workgroup_size_x": (h) => `(_ms_gpu_kern_wgx(${h}))`,
    "__builtin_gpu_kernel_workgroup_size_y": (h) => `(_ms_gpu_kern_wgy(${h}))`,
    "__builtin_gpu_kernel_workgroup_size_z": (h) => `(_ms_gpu_kern_wgz(${h}))`,
    "__builtin_gpu_kernel_handle":       (idx)  => `(_ms_gpu_kern_by_index(${idx}))`,
    "__builtin_gpu_args_create":         ()           => `(_ms_gpu_args_create())`,
    "__builtin_gpu_args_push_buffer":    (h, b)       => `(_ms_gpu_args_push(${h},_ms_gpu_buf_addr(${b})),0)`,
    "__builtin_gpu_args_push_i32":       (h, v)       => `(_ms_gpu_args_push(${h},${v}),0)`,
    "__builtin_gpu_args_push_u32":       (h, v)       => `(_ms_gpu_args_push(${h},${v}),0)`,
    "__builtin_gpu_args_push_i64":       (h, v)       => `(_ms_gpu_args_push(${h},${v}),0)`,
    "__builtin_gpu_args_push_u64":       (h, v)       => `(_ms_gpu_args_push(${h},${v}),0)`,
    "__builtin_gpu_args_push_f32":       (h, v)       => `(_ms_gpu_args_push(${h},${v}),0)`,
    "__builtin_gpu_args_push_f64":       (h, v)       => `(_ms_gpu_args_push(${h},${v}),0)`,
    "__builtin_gpu_args_push_boolean":   (h, v)       => `(_ms_gpu_args_push(${h},${v}),0)`,
    "__builtin_gpu_args_count":          (h)          => `(_ms_gpu_args_count(${h}))`,
    "__builtin_gpu_args_clear":          (h)          => `(_ms_gpu_args_clear(${h}),0)`,
    "__builtin_gpu_dispatch":            (k, a, gx, gy, gz) => `(_ms_gpu_dispatch(${k},${a},${gx},${gy},${gz}),0)`,
    "__builtin_gpu_sync":                ()           => `(0)`,
    "__builtin_gpu_flush":               ()           => `(0)`,
    "__builtin_gpu_thread_global_id_x":      () => `(_ms_gpu_ctx.gix)`,
    "__builtin_gpu_thread_global_id_y":      () => `(_ms_gpu_ctx.giy)`,
    "__builtin_gpu_thread_global_id_z":      () => `(_ms_gpu_ctx.giz)`,
    "__builtin_gpu_thread_local_id_x":       () => `(_ms_gpu_ctx.lix)`,
    "__builtin_gpu_thread_local_id_y":       () => `(_ms_gpu_ctx.liy)`,
    "__builtin_gpu_thread_local_id_z":       () => `(_ms_gpu_ctx.liz)`,
    "__builtin_gpu_thread_workgroup_id_x":   () => `(_ms_gpu_ctx.wix)`,
    "__builtin_gpu_thread_workgroup_id_y":   () => `(_ms_gpu_ctx.wiy)`,
    "__builtin_gpu_thread_workgroup_id_z":   () => `(_ms_gpu_ctx.wiz)`,
    "__builtin_gpu_thread_workgroup_size":   () => `(_ms_gpu_ctx.wgx)`,
    "__builtin_gpu_barrier":                 () => `(0)`,
    "__builtin_gpu_storage_barrier":         () => `(0)`,
    // GPU アトミック (シングルスレッドなので普通の RMW)
    "__builtin_gpu_atomic_add_u32":   (p, v) => `(()=>{const _a=(${p})|0;const _c=_ms_heap[_a]>>>0;_ms_heap[_a]=(_c+(${v}>>>0))>>>0;return _c;})()`,
    "__builtin_gpu_atomic_sub_u32":   (p, v) => `(()=>{const _a=(${p})|0;const _c=_ms_heap[_a]>>>0;_ms_heap[_a]=(_c-(${v}>>>0))>>>0;return _c;})()`,
    "__builtin_gpu_atomic_min_u32":   (p, v) => `(()=>{const _a=(${p})|0;const _c=_ms_heap[_a]>>>0;const _n=(${v})>>>0;_ms_heap[_a]=_n<_c?_n:_c;return _c;})()`,
    "__builtin_gpu_atomic_max_u32":   (p, v) => `(()=>{const _a=(${p})|0;const _c=_ms_heap[_a]>>>0;const _n=(${v})>>>0;_ms_heap[_a]=_n>_c?_n:_c;return _c;})()`,
    "__builtin_gpu_atomic_cas_u32":   (p, e, d) => `(()=>{const _a=(${p})|0;const _c=_ms_heap[_a]>>>0;if(_c===(${e}>>>0))_ms_heap[_a]=(${d})>>>0;return _c;})()`,
    "__builtin_gpu_atomic_load_u32":  (p)    => `(_ms_heap[(${p})|0]>>>0)`,
    "__builtin_gpu_atomic_store_u32": (p, v) => `(_ms_heap[(${p})|0]=(${v})>>>0,0)`,
    "__builtin_gpu_atomic_add_i32":   (p, v) => `(()=>{const _a=(${p})|0;const _c=_ms_heap[_a]|0;_ms_heap[_a]=(_c+((${v})|0))|0;return _c;})()`,
    "__builtin_gpu_atomic_sub_i32":   (p, v) => `(()=>{const _a=(${p})|0;const _c=_ms_heap[_a]|0;_ms_heap[_a]=(_c-((${v})|0))|0;return _c;})()`,
    "__builtin_gpu_atomic_min_i32":   (p, v) => `(()=>{const _a=(${p})|0;const _c=_ms_heap[_a]|0;const _n=(${v})|0;_ms_heap[_a]=_n<_c?_n:_c;return _c;})()`,
    "__builtin_gpu_atomic_max_i32":   (p, v) => `(()=>{const _a=(${p})|0;const _c=_ms_heap[_a]|0;const _n=(${v})|0;_ms_heap[_a]=_n>_c?_n:_c;return _c;})()`,
    "__builtin_gpu_atomic_cas_i32":   (p, e, d) => `(()=>{const _a=(${p})|0;const _c=_ms_heap[_a]|0;if(_c===((${e})|0))_ms_heap[_a]=(${d})|0;return _c;})()`,
    "__builtin_gpu_atomic_load_i32":  (p)    => `(_ms_heap[(${p})|0]|0)`,
    "__builtin_gpu_atomic_store_i32": (p, v) => `(_ms_heap[(${p})|0]=(${v})|0,0)`,
    "__builtin_gpu_fma":              (a, b, c) => `(Math.fround((${a})*(${b})+(${c})))`,
    "__builtin_gpu_dot_f32x4":        (a, b) => `(()=>{const _a=(${a})|0;const _b=(${b})|0;let _s=0;for(let _i=0;_i<4;_i++){_s=Math.fround(_s+Math.fround(_ms_heap_f32(_a,_i)*_ms_heap_f32(_b,_i)));}return _s;})()`,
};

// sizeof マッピング (バイト数)
const SIZEOF_BITS: Record<string, number> = {
    "_m8": 1, "_m16": 2, "_m32": 4, "_m64": 8, "_m128": 16, "_m256": 32, "_m512": 64,
};

// ── JSCodegen ─────────────────────────────────────────────────────────────────

interface WrapperInfo {
    field: string;  // 単一プライベートフィールド名 (通常 "bits")
    bits: string;   // "_m32" など
}

export class JSCodegen {
    private classes      = new Map<string, ClassDecl>();
    private functions    = new Map<string, FunctionDecl>();
    private globals      = new Map<string, ASTNode>();       // top-level VarDecl (name → value node)
    private globalTypes  = new Map<string, string>();        // name → resolvedType
    private wrappers     = new Map<string, WrapperInfo>();   // 検出済み wrapper
    private genericInsts     = new Set<string>();            // 具体型インスタンス (例: "Array<u32>")
    private genericFuncInsts = new Map<string, Set<string>>(); // generic func → concrete T types
    private loadedFiles  = new Set<string>();
    private tmpCount     = 0;

    // ── AST 読み込み ──────────────────────────────────────────────────────────

    loadAST(filePath: string): void {
        if (this.loadedFiles.has(filePath)) return;
        this.loadedFiles.add(filePath);

        const astPath = filePath + ".ast.json";
        const ast: MozaicScriptAST = JSON.parse(fs.readFileSync(astPath, "utf-8"));

        for (const node of ast.nodes) {
            if (node.type === "ImportDecl") {
                const dep = nodePath.resolve(nodePath.dirname(filePath), node.path);
                this.loadAST(dep);
            }
        }

        for (const node of ast.nodes) {
            if (node.type === "ClassDecl") {
                this.classes.set(node.name, node);
            } else if (node.type === "FunctionDecl") {
                this.functions.set(node.name, node);
            } else if (node.type === "VarDecl") {
                this.globals.set(node.name, node.value);
                this.globalTypes.set(node.name, node.resolvedType);
            }
        }

        this.scanGenericInsts(ast.nodes, new Set());
    }

    // ── ジェネリックインスタンス収集 ─────────────────────────────────────────

    private scanGenericInsts(nodes: ASTNode[], typeParams: Set<string>): void {
        for (const node of nodes) this.scanNode(node, typeParams);
    }

    private collectType(t: string, typeParams: Set<string>): void {
        const base = baseType(t);
        if (typeParams.has(base)) return;
        const args = typeArgs(t);
        if (args.length > 0 && !args.some(a => typeParams.has(baseType(a)))) {
            this.genericInsts.add(t);
            args.forEach(a => this.collectType(a, typeParams));
        }
    }

    private scanNode(node: ASTNode, tp: Set<string>): void {
        if (!node) return;
        switch (node.type) {
            case "ClassDecl": {
                const ex = new Set([...tp, ...node.typeParams]);
                node.members.forEach(m => this.collectType(m.resolvedType, ex));
                node.methods.forEach(m => this.scanFnBody(m.body, ex));
                break;
            }
            case "FunctionDecl":
                this.scanFnBody(node.body, tp);
                break;
            case "NewExpr":
                this.collectType(node.resolvedType, tp);
                (node.args ?? []).forEach(a => this.scanNode(a, tp));
                ((node as any).elements ?? []).forEach((e: ASTNode) => this.scanNode(e, tp));
                break;
            case "MethodCall": {
                this.collectType(node.resolvedType, tp);
                this.collectType((node.receiver as any).resolvedType ?? "", tp);
                this.scanNode(node.receiver, tp);
                node.args.forEach(a => this.scanNode(a, tp));
                // track generic top-level function instantiations
                if (node.receiver.type === "Identifier") {
                    const rname = (node.receiver as any).name as string;
                    const simpleName = rname.includes(".") ? rname.slice(rname.lastIndexOf(".") + 1) : rname;
                    const fn = this.functions.get(simpleName);
                    if (fn && fn.typeParams.length > 0) {
                        const concreteT = (node.receiver as any).resolvedType as string;
                        if (concreteT && concreteT !== simpleName) {
                            if (!this.genericFuncInsts.has(simpleName)) this.genericFuncInsts.set(simpleName, new Set());
                            this.genericFuncInsts.get(simpleName)!.add(concreteT);
                        }
                    }
                }
                break;
            }
            case "Intrinsic":
                node.args.forEach(a => this.scanNode(a, tp));
                break;
            case "MemberAccess":
                this.scanNode(node.receiver, tp);
                break;
            case "BorrowExpr":
                this.scanNode((node as any).expr, tp);
                break;
            case "VarDecl":
                this.scanNode(node.value, tp);
                break;
            case "Assign":
                this.scanNode(node.target, tp);
                this.scanNode(node.value, tp);
                break;
            case "IfStmt":
                this.scanNode(node.cond, tp);
                node.body.forEach(n => this.scanNode(n, tp));
                if (node.else) this.scanNode(node.else as unknown as ASTNode, tp);
                break;
            case "WhileStmt":
                this.scanNode(node.cond, tp);
                node.body.forEach(n => this.scanNode(n, tp));
                break;
            case "ForStmt":
                this.scanNode(node.init, tp);
                this.scanNode(node.cond, tp);
                this.scanNode(node.update, tp);
                node.body.forEach(n => this.scanNode(n, tp));
                break;
            case "ReturnStmt":
                if (node.value) this.scanNode(node.value, tp);
                break;
            case "BlockStmt":
                node.body.forEach(n => this.scanNode(n, tp));
                break;
        }
    }

    private scanFnBody(body: ASTNode[], tp: Set<string>): void {
        body.forEach(n => this.scanNode(n, tp));
    }

    // ── ラッパー検出 ─────────────────────────────────────────────────────────

    private detectWrappers(): void {
        for (const [name, cls] of this.classes) {
            if (cls.typeParams.length > 0) continue; // ジェネリッククラスはスキップ
            // "private" or "mocp public" (core lib internal) are both single-field markers
            const privs = cls.members.filter(m => m.access === "private" || m.access === "mocp public");
            if (privs.length === 1 && privs[0].resolvedType.startsWith("_m")) {
                // ラッパー判定の追加条件: constructor が 1 個の _mXX 引数を取り、
                // 直接フィールドに代入する素通しパターンであること。
                // GpuArgs のような () コンストラクタ内で intrinsic を呼ぶ初期化型は
                // ラッパーとして扱うと値が落ちるため除外する。
                const ctor = cls.methods.find(m => m.name === "constructor");
                if (!ctor || ctor.params.length !== 1) continue;
                const p0 = ctor.params[0];
                if (!p0.resolvedType.startsWith("_m")) continue;
                this.wrappers.set(name, { field: privs[0].name, bits: privs[0].resolvedType });
            }
        }
    }

    private isWrapper(mozType: string): WrapperInfo | undefined {
        return this.wrappers.get(baseType(mozType));
    }

    // ── エミット ──────────────────────────────────────────────────────────────

    emit(): string {
        this.detectWrappers();
        const parts: string[] = [
            '"use strict";',
            this.emitRuntime(),
            this.emitAllClasses(),
            this.emitAllFunctions(),
            this.emitFnRegistry(),
            this.emitGpuKernelRegistry(),
            this.emitGlobals(),
            "_top_main();",
        ];
        return parts.filter(Boolean).join("\n\n");
    }

    // gpu 関数 (`__gpu_kernel_<name>`) を _ms_gpu_register_kernel で登録する。
    // 登録順は kernel-name インターン ID (チェッカーが globalEnv 登録順に発行) と一致する。
    // 引数型情報も渡しランタイムが Ptr<T> をオブジェクト化する。
    private emitGpuKernelRegistry(): string {
        const lines: string[] = [];
        for (const [name, fn] of this.functions) {
            if (!fn.isGpu) continue;
            const actual = name.startsWith("__gpu_kernel_") ? name.slice("__gpu_kernel_".length) : name;
            const wgs = fn.workgroupSize ?? [64, 1, 1];
            const jsFn = jsTopFnName(name);
            const paramTypes = fn.params.map(p => p.resolvedType);
            lines.push(`_ms_gpu_register_kernel(${JSON.stringify(actual)}, ${jsFn}, ${wgs[0]}, ${wgs[1]}, ${wgs[2]}, ${JSON.stringify(paramTypes)});`);
        }
        return lines.join("\n");
    }

    private emitFnRegistry(): string {
        const lines: string[] = [];
        for (const [name, fn] of this.functions) {
            if (fn.typeParams.length > 0) {
                const insts = this.genericFuncInsts.get(name);
                if (!insts) continue;
                for (const concreteT of insts) {
                    const jsName = jsTopFnName(name, concreteT);
                    lines.push(`_ms_fn_registry[${JSON.stringify(name)}] = ${jsName};`);
                }
            } else {
                lines.push(`_ms_fn_registry[${JSON.stringify(name)}] = ${jsTopFnName(name)};`);
            }
        }
        return lines.join("\n");
    }

    private emitGlobals(): string {
        const lines: string[] = [];
        const typeEnv = new Map<string, string>();
        for (const [name, valueNode] of this.globals) {
            const pre: string[] = [];
            const expr = this.emitExpr(valueNode, pre, typeEnv, new Map());
            for (const s of pre) lines.push(s);
            lines.push(`let _v_${name} = ${expr};`);
        }
        return lines.join("\n");
    }

    // ── Array クラスのフィールド名をクラス定義から読む ────────────────────────

    private arrayFields(): { ptr: string; length: string } {
        const cls = this.classes.get("Array");
        if (!cls) return { ptr: "ptr", length: "length" };
        // ヒープポインタ: private の _m32 フィールド
        const ptrField = cls.members.find(m => m.resolvedType === "_m32" && m.access === "private");
        // 要素数: 上記以外の最初のフィールド
        const lenField = cls.members.find(m => m !== ptrField);
        return { ptr: ptrField?.name ?? "ptr", length: lenField?.name ?? "length" };
    }

    // ── ランタイム ────────────────────────────────────────────────────────────

    private emitRuntime(): string {
        const { ptr, length } = this.arrayFields();
        return `\
/* ── mozaicScript JS runtime ── */
let _ms_heap = new Int32Array(1 << 20); // start 4 MiB, grows on demand
let _ms_heap_next = 1;
function _ms_malloc(n_bytes) {
    const a = _ms_heap_next;
    _ms_heap_next += ((n_bytes + 3) >> 2) | 0;
    if (_ms_heap_next > _ms_heap.length) {
        const next = new Int32Array(Math.max(_ms_heap.length * 2, _ms_heap_next));
        next.set(_ms_heap);
        _ms_heap = next;
    }
    return a;
}
function _ms_free(_ptr) {}

function _ms_array_to_str(arr) {
    const len = arr.${length} | 0;
    const ptr = arr.${ptr} | 0;
    if (len <= 0) return "";
    const buf = new Uint16Array(len);
    for (let _i = 0; _i < len; _i++) buf[_i] = _ms_heap[ptr + _i] >>> 0;
    return String.fromCharCode(...buf);
}
function _ms_stdout_write(arr) { process.stdout.write(_ms_array_to_str(arr)); }
function _ms_stderr_write(arr) { process.stderr.write(_ms_array_to_str(arr)); }
function _ms_panic(arr) { throw new Error("[PANIC] " + _ms_array_to_str(arr)); }
// thread / threadpool stubs (single-threaded: run synchronously)
// fn is a mozaicScript string (Array<u32>); look up in explicit registry
const _ms_fn_registry = {};
function _ms_call_by_name(fnName) { const f = _ms_fn_registry[_ms_array_to_str(fnName)]; if (f) f(); }
const _ms_threads = new Map();
let _ms_tid = 1;
function _ms_thread_spawn(fn, _args) { const id = _ms_tid++; _ms_call_by_name(fn); _ms_threads.set(id, null); return id; }
function _ms_thread_join(id) { _ms_threads.delete(id); }
const _ms_tpools = new Map();
let _ms_tpid = 1;
function _ms_tp_create(sz) { const id = _ms_tpid++; _ms_tpools.set(id, []); return id; }
function _ms_tp_submit(p, fn, _args) { _ms_call_by_name(fn); }
function _ms_tp_wait(p) {}
function _ms_tp_destroy(p) { _ms_tpools.delete(p); }

// ── GPU エミュレーション (CPU 同期実行) ──
// kernels: name → { fn, wgx, wgy, wgz }; kernel handle = registration index+1
const _ms_gpu_kernels = [];      // [{ name, fn, wgx, wgy, wgz, paramTypes }]
const _ms_gpu_kernels_by_name = {};
function _ms_gpu_register_kernel(name, fn, wgx, wgy, wgz, paramTypes) {
    const existing = _ms_gpu_kernels_by_name[name];
    if (existing !== undefined) return existing;
    const id = _ms_gpu_kernels.length + 1;
    _ms_gpu_kernels.push({ name, fn, wgx: wgx|0, wgy: wgy|0, wgz: wgz|0, paramTypes: paramTypes || [] });
    _ms_gpu_kernels_by_name[name] = id;
    return id;
}
function _ms_gpu_kern_by_index(idx) {
    // idx は compiler が割り当てた kernel-name インターン ID。
    // 登録順と一致するので idx+1 をそのまま handle として返す。
    return ((idx|0) + 1);
}
function _ms_gpu_kern_name(_h) { return { ptr: 0, length: 0 }; }
function _ms_gpu_kern_wgx(h) { return _ms_gpu_kernels[(h|0) - 1].wgx; }
function _ms_gpu_kern_wgy(h) { return _ms_gpu_kernels[(h|0) - 1].wgy; }
function _ms_gpu_kern_wgz(h) { return _ms_gpu_kernels[(h|0) - 1].wgz; }

const _ms_gpu_buffers = new Map(); // handle → { addr, byteSize }
let _ms_gpu_next_id = 1;
function _ms_gpu_buf_create(byteSize) {
    const addr = _ms_malloc(byteSize|0);
    const h = _ms_gpu_next_id++;
    _ms_gpu_buffers.set(h, { addr, byteSize: byteSize|0 });
    return h;
}
function _ms_gpu_buf_addr(h) { return _ms_gpu_buffers.get(h|0).addr; }
function _ms_gpu_buf_size(h) { return _ms_gpu_buffers.get(h|0).byteSize; }
function _ms_gpu_buf_free(h) { _ms_gpu_buffers.delete(h|0); }

const _ms_gpu_args = new Map();
function _ms_gpu_args_create() { const h = _ms_gpu_next_id++; _ms_gpu_args.set(h, []); return h; }
function _ms_gpu_args_push(h, v) { _ms_gpu_args.get(h|0).push(v); }
function _ms_gpu_args_count(h) { return _ms_gpu_args.get(h|0).length; }
function _ms_gpu_args_clear(h) { _ms_gpu_args.set(h|0, []); }

// thread-local context (per CPU thread = global for sequential exec)
const _ms_gpu_ctx = { gix:0, giy:0, giz:0, lix:0, liy:0, liz:0, wix:0, wiy:0, wiz:0, wgx:1 };

function _ms_gpu_dispatch(kHandle, aHandle, gx, gy, gz) {
    const k = _ms_gpu_kernels[(kHandle|0) - 1];
    if (!k) throw new Error("Unknown gpu kernel handle " + kHandle);
    const rawArgs = _ms_gpu_args.get(aHandle|0) ?? [];
    // 引数を kernel パラメータ型に合わせて materialize
    // Ptr<T> は { addr: number } オブジェクトに、Array<T> は { ptr, length: 0 } に、
    // スカラー (i32/u32/f32 等) はそのまま bare number で渡す。
    const args = rawArgs.map((v, i) => {
        const pt = k.paramTypes[i] || "";
        if (pt.startsWith("Ptr<"))   return { addr: v };
        if (pt.startsWith("Array<")) return { ptr: v, length: 0 };
        return v;
    });
    const wgX = k.wgx, wgY = k.wgy, wgZ = k.wgz;
    const prev = Object.assign({}, _ms_gpu_ctx);
    _ms_gpu_ctx.wgx = wgX;
    for (let wz = 0; wz < (gz|0); wz++) for (let wy = 0; wy < (gy|0); wy++) for (let wx = 0; wx < (gx|0); wx++) {
        _ms_gpu_ctx.wix = wx; _ms_gpu_ctx.wiy = wy; _ms_gpu_ctx.wiz = wz;
        for (let lz = 0; lz < wgZ; lz++) for (let ly = 0; ly < wgY; ly++) for (let lx = 0; lx < wgX; lx++) {
            _ms_gpu_ctx.lix = lx; _ms_gpu_ctx.liy = ly; _ms_gpu_ctx.liz = lz;
            _ms_gpu_ctx.gix = wx * wgX + lx;
            _ms_gpu_ctx.giy = wy * wgY + ly;
            _ms_gpu_ctx.giz = wz * wgZ + lz;
            k.fn(...args);
        }
    }
    Object.assign(_ms_gpu_ctx, prev);
}

// f32 を _ms_heap (Int32Array) から bit pattern 経由で取り出す
const _ms_f32buf = new ArrayBuffer(4);
const _ms_f32_i = new Int32Array(_ms_f32buf);
const _ms_f32_f = new Float32Array(_ms_f32buf);
function _ms_heap_f32(addr, off) { _ms_f32_i[0] = _ms_heap[addr + off]; return _ms_f32_f[0]; }`;
    }

    // ── クラスメソッド出力 ────────────────────────────────────────────────────

    private emitAllClasses(): string {
        const parts: string[] = [];

        // 非ジェネリッククラス (wrapper クラスも bare-number 関数として emit)
        for (const [name, cls] of this.classes) {
            if (cls.typeParams.length > 0) continue;
            for (const method of cls.methods) {
                // method-level generic はサポート外 (codegen が monomorphize しない)。
                // 型固定版を別途定義する慣習で運用するため、ここでは emit をスキップする。
                if (method.typeParams.length > 0) continue;
                parts.push(this.emitMethod(name, method, new Map()));
            }
        }

        // ジェネリッククラスの具体インスタンス
        for (const inst of this.genericInsts) {
            // method-level generic 内の `Ptr<T>` のような未解決型は emit しない
            const tArgs = typeArgs(inst);
            if (tArgs.length === 0) continue;
            if (tArgs.some(a => a.length === 1 && a >= 'A' && a <= 'Z')) continue;
            const base = baseType(inst);
            const cls = this.classes.get(base);
            if (!cls || cls.typeParams.length === 0) continue;
            const args = typeArgs(inst);
            const subst = new Map<string, string>();
            cls.typeParams.forEach((p, i) => subst.set(p, args[i] ?? p));
            for (const method of cls.methods) {
                parts.push(this.emitMethod(inst, method, subst));
            }
        }

        return parts.join("\n");
    }

    private emitMethod(receiverType: string, method: FunctionDecl, subst: Map<string, string>): string {
        const fnName = jsFnName(receiverType, method.name);
        const typeEnv = new Map<string, string>();
        typeEnv.set("this", receiverType);
        const params = ["_v_this"];
        for (const p of method.params) {
            const t = applySubst(p.resolvedType, subst);
            typeEnv.set(p.name, t);
            params.push(`_v_${p.name}`);
        }
        const body = this.emitBody(method.body, typeEnv, "  ", subst);
        return `function ${fnName}(${params.join(", ")}) {\n${body}\n}`;
    }

    // ── トップレベル関数出力 ──────────────────────────────────────────────────

    private emitAllFunctions(): string {
        const parts: string[] = [];
        for (const [name, fn] of this.functions) {
            if (fn.typeParams.length > 0) {
                // generic function: emit one concrete version per observed instantiation
                const insts = this.genericFuncInsts.get(name);
                if (!insts) continue;
                for (const concreteT of insts) {
                    const subst = new Map<string, string>();
                    fn.typeParams.forEach(p => subst.set(p, concreteT));
                    const fnName = jsTopFnName(name, concreteT);
                    const typeEnv = new Map<string, string>();
                    const params: string[] = [];
                    for (const p of fn.params) {
                        const t = applySubst(p.resolvedType, subst);
                        typeEnv.set(p.name, t);
                        params.push(`_v_${p.name}`);
                    }
                    const body = this.emitBody(fn.body, typeEnv, "  ", subst);
                    parts.push(`function ${fnName}(${params.join(", ")}) {\n${body}\n}`);
                }
            } else {
                const fnName = jsTopFnName(name);
                const typeEnv = new Map<string, string>();
                const params: string[] = [];
                for (const p of fn.params) {
                    typeEnv.set(p.name, p.resolvedType);
                    params.push(`_v_${p.name}`);
                }
                const body = this.emitBody(fn.body, typeEnv, "  ", new Map());
                parts.push(`function ${fnName}(${params.join(", ")}) {\n${body}\n}`);
            }
        }
        return parts.join("\n");
    }

    // ── ボディ / 文 ──────────────────────────────────────────────────────────

    private emitBody(stmts: ASTNode[], typeEnv: Map<string, string>, indent: string, subst: Map<string, string>): string {
        const lines: string[] = [];
        for (const stmt of stmts) {
            const pre: string[] = [];
            const line = this.emitStmt(stmt, pre, typeEnv, indent, subst);
            pre.forEach(p => lines.push(indent + p));
            if (line) lines.push(indent + line);
        }
        return lines.join("\n");
    }

    private emitStmt(node: ASTNode, pre: string[], typeEnv: Map<string, string>, indent: string, subst: Map<string, string>): string {
        switch (node.type) {
            case "VarDecl": {
                const resolvedType = applySubst(node.resolvedType, subst);
                typeEnv.set(node.name, resolvedType);
                const val = this.emitExpr(node.value, pre, typeEnv, subst);
                return `let _v_${node.name} = ${val};`;
            }

            case "Assign": {
                const val = this.emitExpr(node.value, pre, typeEnv, subst);
                if (node.target.type === "Identifier") {
                    return `_v_${node.target.name} = ${val};`;
                }
                if (node.target.type === "MemberAccess") {
                    const recvType = this.typeOf(node.target.receiver, typeEnv);
                    const w = this.isWrapper(recvType);
                    if (w && w.field === node.target.member) {
                        // wrapper フィールドへの代入 → 変数そのものへ代入
                        if (node.target.receiver.type === "Identifier") {
                            return `_v_${node.target.receiver.name} = ${val};`;
                        }
                    }
                    const recv = this.emitExpr(node.target.receiver, pre, typeEnv, subst);
                    return `(${recv}).${node.target.member} = ${val};`;
                }
                return "";
            }

            case "IfStmt": {
                const cond = this.emitExpr(node.cond, pre, typeEnv, subst);
                const body = this.emitBody(node.body, new Map(typeEnv), indent + "  ", subst);
                let s = `if (${cond}) {\n${body}\n${indent}}`;
                if (node.else) {
                    if ((node.else as any).type === "IfStmt") {
                        const elseStr = this.emitStmt(node.else as unknown as ASTNode, pre, typeEnv, indent, subst);
                        s += ` else ${elseStr}`;
                    } else {
                        const elseBody = this.emitBody((node.else as any).body, new Map(typeEnv), indent + "  ", subst);
                        s += ` else {\n${elseBody}\n${indent}}`;
                    }
                }
                return s;
            }

            case "WhileStmt": {
                const cond = this.emitExpr(node.cond, pre, typeEnv, subst);
                const body = this.emitBody(node.body, new Map(typeEnv), indent + "  ", subst);
                return `while (${cond}) {\n${body}\n${indent}}`;
            }

            case "ForStmt": {
                const initPre: string[] = [];
                const init = this.emitStmt(node.init, initPre, typeEnv, indent, subst).replace(/;$/, "");
                const cond = this.emitExpr(node.cond, pre, typeEnv, subst);
                const updPre: string[] = [];
                const upd  = this.emitStmt(node.update, updPre, typeEnv, indent, subst).replace(/;$/, "");
                const body = this.emitBody(node.body, new Map(typeEnv), indent + "  ", subst);
                initPre.forEach(p => pre.push(p));
                return `for (${init}; ${cond}; ${upd}) {\n${body}\n${indent}}`;
            }

            case "ReturnStmt": {
                if (!node.value) return "return;";
                const val = this.emitExpr(node.value, pre, typeEnv, subst);
                return `return ${val};`;
            }

            case "BreakStmt":
                return "break;";

            case "BlockStmt": {
                const blockBody = this.emitBody(node.body, typeEnv, indent + "    ", subst);
                return `{\n${blockBody}\n${indent}}`;
            }

            default: {
                // 式文 (Intrinsic, MethodCall, etc.)
                const expr = this.emitExpr(node, pre, typeEnv, subst);
                return expr ? `${expr};` : "";
            }
        }
    }

    // ── 式 ───────────────────────────────────────────────────────────────────

    private emitExpr(node: ASTNode, pre: string[], typeEnv: Map<string, string>, subst: Map<string, string>): string {
        switch (node.type) {
            case "RawLiteral":
                return String((node as any).value);

            case "Identifier":
                if (node.name === "this") return "_v_this";
                return `_v_${node.name}`;

            case "MemberAccess": {
                const recvType = this.typeOf(node.receiver, typeEnv);
                const w = this.isWrapper(recvType);
                if (w && w.field === node.member) {
                    // wrapper.bits → wrapper そのもの (bare number)
                    return this.emitExpr(node.receiver, pre, typeEnv, subst);
                }
                const recv = this.emitExpr(node.receiver, pre, typeEnv, subst);
                return `(${recv}).${node.member}`;
            }

            case "NewExpr": {
                const resolvedType = applySubst(node.resolvedType, subst);

                // 文字列/配列リテラル (elements フィールドあり)
                if ((node as any).elements !== undefined) {
                    return this.emitArrayLiteral(node as any, pre, typeEnv, subst, resolvedType);
                }

                // プリミティブラッパー → bare number
                const w = this.isWrapper(resolvedType);
                if (w) {
                    if (node.args.length === 0) {
                        // f32/f64 はゼロを float として返す
                        if (resolvedType === "f32") return "Math.fround(0)";
                        if (resolvedType === "f64") return "(+0)";
                        return coerce("0", w.bits);
                    }
                    const arg = this.emitExpr(node.args[0], pre, typeEnv, subst);
                    // f32/f64 は Math.fround/+ を使い |0 を回避
                    if (resolvedType === "f32") return `Math.fround(${arg})`;
                    if (resolvedType === "f64") return `(+(${arg}))`;
                    return coerce(arg, w.bits);
                }

                // _mXX 直接 → bare number
                if (resolvedType.startsWith("_m")) {
                    if (node.args.length === 0) return "0";
                    return this.emitExpr(node.args[0], pre, typeEnv, subst);
                }

                // オブジェクト型 → tmp object + constructor call
                return this.emitNewObject(resolvedType, node.args, pre, typeEnv, subst);
            }

            case "MethodCall": {
                const recvType = applySubst(
                    (node.receiver as any).resolvedType ?? this.typeOf(node.receiver, typeEnv),
                    subst
                );
                // _m32/_m64 はプリミティブ生値 — getBits() は恒等操作なので直接返す
                if ((recvType === "_m32" || recvType === "_m64") && node.method === "getBits") {
                    return this.emitExpr(node.receiver, pre, typeEnv, subst);
                }
                // free function call: receiver is an Identifier matching a top-level function.
                // Namespace-qualified names like "Geo.max" strip the prefix to look up "max".
                if (node.receiver.type === "Identifier") {
                    const recvName = (node.receiver as any).name as string;
                    const simpleName = recvName.includes(".") ? recvName.slice(recvName.lastIndexOf(".") + 1) : recvName;
                    const matchedFn = this.functions.get(simpleName);
                    if (matchedFn) {
                        const args = node.args.map(a => this.emitExpr(a, pre, typeEnv, subst));
                        // for generic functions, derive concrete T from receiver's resolvedType
                        let concreteT: string | undefined;
                        if (matchedFn.typeParams.length > 0) {
                            concreteT = applySubst((node.receiver as any).resolvedType ?? "", subst) || undefined;
                        }
                        return `${jsTopFnName(simpleName, concreteT)}(${args.join(", ")})`;
                    }
                }
                const recv = this.emitExpr(node.receiver, pre, typeEnv, subst);
                const args = node.args.map(a => this.emitExpr(a, pre, typeEnv, subst));
                const fn = jsFnName(recvType, node.method);
                return `${fn}(${[recv, ...args].join(", ")})`;
            }

            case "Intrinsic": {
                const name = (node as any).name as string;

                if (name === "__builtin_if" || name === "__builtin_while") {
                    return this.emitExpr((node as any).args[0], pre, typeEnv, subst);
                }

                if (name === "__builtin_sizeof") {
                    const tt = applySubst((node as any).targetType ?? "i32", subst);
                    return String(this.sizeofType(tt));
                }

                const tmpl = INTRINSIC_JS[name];
                if (!tmpl) throw new Error(`Unknown intrinsic: ${name}`);
                const args = (node as any).args.map((a: ASTNode) => this.emitExpr(a, pre, typeEnv, subst));
                return tmpl(...args);
            }

            case "BorrowExpr":
                // ゼロコスト借用: JS では値そのもの (number / object) を透過
                return this.emitExpr((node as any).expr, pre, typeEnv, subst);

            default:
                return "0";
        }
    }

    // ── 配列リテラル (NewExpr { elements }) ──────────────────────────────────

    private emitArrayLiteral(node: any, pre: string[], typeEnv: Map<string, string>, subst: Map<string, string>, resolvedType: string): string {
        const elems: any[] = node.elements ?? [];
        const tmp = `_t${this.tmpCount++}`;
        const cls = this.classes.get(baseType(resolvedType));
        const fields = cls ? this.zeroFields(cls, resolvedType, subst) : "{}";
        pre.push(`const ${tmp} = ${fields};`);

        const { ptr: ptrField, length: lenField } = this.arrayFields();

        if (elems.length > 0) {
            pre.push(`${tmp}.${ptrField} = _ms_malloc(${elems.length * 4});`);
            pre.push(`${tmp}.${lenField} = ${elems.length};`);
            elems.forEach((e, i) => {
                const v = typeof e === "object" && "value" in e ? String(e.value) : this.emitExpr(e as ASTNode, pre, typeEnv, subst);
                pre.push(`_ms_heap[${tmp}.${ptrField} + ${i}] = ${v};`);
            });
        } else {
            pre.push(`${tmp}.${ptrField} = 0;`);
            pre.push(`${tmp}.${lenField} = 0;`);
        }
        return tmp;
    }

    // ── オブジェクト生成 ──────────────────────────────────────────────────────

    private emitNewObject(resolvedType: string, args: ASTNode[], pre: string[], typeEnv: Map<string, string>, subst: Map<string, string>): string {
        const base = baseType(resolvedType);
        const cls = this.classes.get(base);
        if (!cls) throw new Error(`Unknown class: ${resolvedType}`);
        const tmp = `_t${this.tmpCount++}`;
        pre.push(`const ${tmp} = ${this.zeroFields(cls, resolvedType, subst)};`);
        const ctor = cls.methods.find(m => m.name === "constructor");
        if (ctor) {
            // ctor が引数を取らない場合でも本体に副作用 (intrinsic 呼び出し等) があり得るので
            // 必ず呼ぶ。args.length と ctor.params.length が一致しない不整合は emit 時には現れない。
            const ctorArgs = args.map(a => this.emitExpr(a, pre, typeEnv, subst));
            pre.push(`${jsFnName(resolvedType, "constructor")}(${tmp}${ctorArgs.length ? ", " + ctorArgs.join(", ") : ""});`);
        }
        return tmp;
    }

    // クラスの全フィールドを 0 で初期化した JS オブジェクト式を返す
    private zeroFields(cls: ClassDecl, _resolvedType: string, _subst: Map<string, string>): string {
        if (cls.members.length === 0) return "{}";
        const fields = cls.members.map(m => `${m.name}:0`).join(",");
        return `{${fields}}`;
    }

    // ── 型情報 ───────────────────────────────────────────────────────────────

    private typeOf(node: ASTNode, typeEnv: Map<string, string>): string {
        if (node.type === "Identifier") {
            if (node.name === "this") {
                return typeEnv.get("this") ?? "";
            }
            return typeEnv.get(node.name) ?? "";
        }
        return (node as any).resolvedType ?? "";
    }

    // ── sizeof ────────────────────────────────────────────────────────────────

    private sizeofType(mozType: string): number {
        const base = baseType(mozType);
        const w = this.wrappers.get(base);
        if (w) return SIZEOF_BITS[w.bits] ?? 4;
        if (mozType.startsWith("_m")) return SIZEOF_BITS[mozType] ?? 4;
        return 4;
    }
}
