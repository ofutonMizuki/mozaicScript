import { RuntimeValue, primitive, voidValue } from "./values";

type BuiltinFn = (args: RuntimeValue[]) => RuntimeValue;

// i64/u64 の演算は BigInt で行い、number で保持する（インタープリタ用近似）
function toI64(n: number): bigint { return BigInt.asIntN(64, BigInt(Math.trunc(n))); }
function toU64(n: number): bigint { return BigInt.asUintN(64, BigInt(Math.trunc(n))); }
function n64(b: bigint): number   { return Number(b); }

function v(x: RuntimeValue): number { return (x as any).value; }

export const builtins: Record<string, BuiltinFn> = Object.fromEntries([

    // ── i32 算術 ──────────────────────────────────────────────────────────────
    ["__builtin_i32_add", ([a, b]) => primitive((v(a) + v(b)) | 0)],
    ["__builtin_i32_sub", ([a, b]) => primitive((v(a) - v(b)) | 0)],
    ["__builtin_i32_mul", ([a, b]) => primitive(Math.imul(v(a), v(b)))],
    ["__builtin_i32_div", ([a, b]) => primitive((v(a) / v(b)) | 0)],
    ["__builtin_i32_mod", ([a, b]) => primitive((v(a) % v(b)) | 0)],
    ["__builtin_i32_eq",  ([a, b]) => primitive(v(a) === v(b) ? 1 : 0)],
    ["__builtin_i32_lt",  ([a, b]) => primitive(v(a) < v(b) ? 1 : 0)],
    ["__builtin_i32_gt",  ([a, b]) => primitive(v(a) > v(b) ? 1 : 0)],
    ["__builtin_i32_neg", ([a])    => primitive((-v(a)) | 0)],

    // ── u32 算術 ──────────────────────────────────────────────────────────────
    ["__builtin_u32_add", ([a, b]) => primitive((v(a) + v(b)) >>> 0)],
    ["__builtin_u32_sub", ([a, b]) => primitive((v(a) - v(b)) >>> 0)],
    ["__builtin_u32_mul", ([a, b]) => primitive(Math.imul(v(a), v(b)) >>> 0)],
    ["__builtin_u32_div", ([a, b]) => primitive((v(a) >>> 0) / (v(b) >>> 0) >>> 0)],
    ["__builtin_u32_mod", ([a, b]) => primitive((v(a) >>> 0) % (v(b) >>> 0) >>> 0)],
    ["__builtin_u32_eq",  ([a, b]) => primitive(v(a) === v(b) ? 1 : 0)],
    ["__builtin_u32_lt",  ([a, b]) => primitive((v(a) >>> 0) < (v(b) >>> 0) ? 1 : 0)],
    ["__builtin_u32_gt",  ([a, b]) => primitive((v(a) >>> 0) > (v(b) >>> 0) ? 1 : 0)],

    // ── f32 算術 ──────────────────────────────────────────────────────────────
    ["__builtin_f32_add", ([a, b]) => primitive(Math.fround(v(a) + v(b)))],
    ["__builtin_f32_sub", ([a, b]) => primitive(Math.fround(v(a) - v(b)))],
    ["__builtin_f32_mul", ([a, b]) => primitive(Math.fround(v(a) * v(b)))],
    ["__builtin_f32_div", ([a, b]) => primitive(Math.fround(v(a) / v(b)))],
    ["__builtin_f32_mod", ([a, b]) => primitive(Math.fround(v(a) % v(b)))],
    ["__builtin_f32_eq",  ([a, b]) => primitive(v(a) === v(b) ? 1 : 0)],
    ["__builtin_f32_lt",  ([a, b]) => primitive(v(a) < v(b) ? 1 : 0)],
    ["__builtin_f32_gt",  ([a, b]) => primitive(v(a) > v(b) ? 1 : 0)],
    ["__builtin_f32_neg", ([a])    => primitive(Math.fround(-v(a)))],

    // ── i64 算術（BigInt で演算、number で保持）────────────────────────────────
    ["__builtin_i64_add", ([a, b]) => primitive(n64(toI64(v(a)) + toI64(v(b))))],
    ["__builtin_i64_sub", ([a, b]) => primitive(n64(toI64(v(a)) - toI64(v(b))))],
    ["__builtin_i64_mul", ([a, b]) => primitive(n64(toI64(v(a)) * toI64(v(b))))],
    ["__builtin_i64_div", ([a, b]) => primitive(n64(toI64(v(a)) / toI64(v(b))))],
    ["__builtin_i64_mod", ([a, b]) => primitive(n64(toI64(v(a)) % toI64(v(b))))],
    ["__builtin_i64_eq",  ([a, b]) => primitive(toI64(v(a)) === toI64(v(b)) ? 1 : 0)],
    ["__builtin_i64_lt",  ([a, b]) => primitive(toI64(v(a)) < toI64(v(b)) ? 1 : 0)],
    ["__builtin_i64_gt",  ([a, b]) => primitive(toI64(v(a)) > toI64(v(b)) ? 1 : 0)],
    ["__builtin_i64_neg", ([a])    => primitive(n64(-toI64(v(a))))],

    // ── u64 算術 ──────────────────────────────────────────────────────────────
    ["__builtin_u64_add", ([a, b]) => primitive(n64(toU64(v(a)) + toU64(v(b))))],
    ["__builtin_u64_sub", ([a, b]) => primitive(n64(toU64(v(a)) - toU64(v(b))))],
    ["__builtin_u64_mul", ([a, b]) => primitive(n64(toU64(v(a)) * toU64(v(b))))],
    ["__builtin_u64_div", ([a, b]) => primitive(n64(toU64(v(a)) / toU64(v(b))))],
    ["__builtin_u64_mod", ([a, b]) => primitive(n64(toU64(v(a)) % toU64(v(b))))],
    ["__builtin_u64_eq",  ([a, b]) => primitive(toU64(v(a)) === toU64(v(b)) ? 1 : 0)],
    ["__builtin_u64_lt",  ([a, b]) => primitive(toU64(v(a)) < toU64(v(b)) ? 1 : 0)],
    ["__builtin_u64_gt",  ([a, b]) => primitive(toU64(v(a)) > toU64(v(b)) ? 1 : 0)],

    // ── f64 算術（JS number は IEEE 754 倍精度なのでそのまま）────────────────────
    ["__builtin_f64_add", ([a, b]) => primitive(v(a) + v(b))],
    ["__builtin_f64_sub", ([a, b]) => primitive(v(a) - v(b))],
    ["__builtin_f64_mul", ([a, b]) => primitive(v(a) * v(b))],
    ["__builtin_f64_div", ([a, b]) => primitive(v(a) / v(b))],
    ["__builtin_f64_mod", ([a, b]) => primitive(v(a) % v(b))],
    ["__builtin_f64_eq",  ([a, b]) => primitive(v(a) === v(b) ? 1 : 0)],
    ["__builtin_f64_lt",  ([a, b]) => primitive(v(a) < v(b) ? 1 : 0)],
    ["__builtin_f64_gt",  ([a, b]) => primitive(v(a) > v(b) ? 1 : 0)],
    ["__builtin_f64_neg", ([a])    => primitive(-v(a))],

    // ── 論理演算（i32） ───────────────────────────────────────────────────────
    ["__builtin_i32_or",  ([a, b]) => primitive(v(a) | v(b))],
    ["__builtin_i32_and", ([a, b]) => primitive(v(a) & v(b))],
    ["__builtin_i32_not", ([a])    => primitive(v(a) === 0 ? 1 : 0)],

    // ── 論理演算（u32） ───────────────────────────────────────────────────────
    ["__builtin_u32_or",  ([a, b]) => primitive((v(a) | v(b)) >>> 0)],
    ["__builtin_u32_and", ([a, b]) => primitive((v(a) & v(b)) >>> 0)],

    // ── 論理演算（i64/u64） ───────────────────────────────────────────────────
    ["__builtin_i64_or",  ([a, b]) => primitive(n64(toI64(v(a)) | toI64(v(b))))],
    ["__builtin_i64_and", ([a, b]) => primitive(n64(toI64(v(a)) & toI64(v(b))))],
    ["__builtin_i64_not", ([a])    => primitive(v(a) === 0 ? 1 : 0)],
    ["__builtin_u64_or",  ([a, b]) => primitive(n64(toU64(v(a)) | toU64(v(b))))],
    ["__builtin_u64_and", ([a, b]) => primitive(n64(toU64(v(a)) & toU64(v(b))))],
    ["__builtin_u64_not", ([a])    => primitive(v(a) === 0 ? 1 : 0)],

    // ── ビットシフト ──────────────────────────────────────────────────────────
    ["__builtin_i32_shl", ([a, b]) => primitive(v(a) << v(b))],
    ["__builtin_i32_shr", ([a, b]) => primitive(v(a) >> v(b))],
    ["__builtin_u32_shl", ([a, b]) => primitive((v(a) >>> 0) << v(b))],
    ["__builtin_u32_shr", ([a, b]) => primitive((v(a) >>> 0) >>> v(b))],
    ["__builtin_i64_shl", ([a, b]) => primitive(n64(toI64(v(a)) << BigInt(v(b) & 63)))],
    ["__builtin_i64_shr", ([a, b]) => primitive(n64(toI64(v(a)) >> BigInt(v(b) & 63)))],
    ["__builtin_u64_shl", ([a, b]) => primitive(n64(toU64(v(a)) << BigInt(v(b) & 63)))],
    ["__builtin_u64_shr", ([a, b]) => primitive(n64(toU64(v(a)) >> BigInt(v(b) & 63)))],

    // ── 整数ビット操作（rotl / rotr / clz / ctz / popcnt） ─────────────────────
    ["__builtin_i32_rotl",   ([a, b]) => { const s = v(b) & 31; return primitive(((v(a) << s) | (v(a) >>> (32 - s))) | 0); }],
    ["__builtin_i32_rotr",   ([a, b]) => { const s = v(b) & 31; return primitive(((v(a) >>> s) | (v(a) << (32 - s))) | 0); }],
    ["__builtin_i32_clz",    ([a])    => primitive(Math.clz32(v(a)))],
    ["__builtin_i32_ctz",    ([a])    => { const x = v(a) | 0; return primitive(x === 0 ? 32 : 31 - Math.clz32(x & -x)); }],
    ["__builtin_i32_popcnt", ([a])    => {
        let x = v(a) >>> 0;
        x = x - ((x >>> 1) & 0x55555555);
        x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
        x = ((x + (x >>> 4)) & 0x0f0f0f0f);
        return primitive(((x * 0x01010101) >>> 24) | 0);
    }],
    ["__builtin_i64_rotl",   ([a, b]) => { const s = BigInt(v(b) & 63); const u = toU64(v(a)); return primitive(n64((u << s) | (u >> (64n - s)))); }],
    ["__builtin_i64_rotr",   ([a, b]) => { const s = BigInt(v(b) & 63); const u = toU64(v(a)); return primitive(n64((u >> s) | (u << (64n - s)))); }],
    ["__builtin_i64_clz",    ([a])    => { const u = toU64(v(a)); if (u === 0n) return primitive(64); let c = 0; let x = u; while (x < (1n << 63n)) { x <<= 1n; c++; } return primitive(c); }],
    ["__builtin_i64_ctz",    ([a])    => { const u = toU64(v(a)); if (u === 0n) return primitive(64); let c = 0; let x = u; while ((x & 1n) === 0n) { x >>= 1n; c++; } return primitive(c); }],
    ["__builtin_i64_popcnt", ([a])    => { let x = toU64(v(a)); let c = 0n; while (x !== 0n) { x &= x - 1n; c++; } return primitive(Number(c)); }],

    // ── 浮動小数点演算（f32） ─────────────────────────────────────────────────
    ["__builtin_f32_abs",     ([a]) => primitive(Math.fround(Math.abs(v(a))))],
    ["__builtin_f32_sqrt",    ([a]) => primitive(Math.fround(Math.sqrt(v(a))))],
    ["__builtin_f32_floor",   ([a]) => primitive(Math.fround(Math.floor(v(a))))],
    ["__builtin_f32_ceil",    ([a]) => primitive(Math.fround(Math.ceil(v(a))))],
    ["__builtin_f32_trunc",   ([a]) => primitive(Math.fround(Math.trunc(v(a))))],
    ["__builtin_f32_nearest", ([a]) => primitive(Math.fround(Math.round(v(a))))],
    ["__builtin_f32_min",     ([a, b]) => primitive(Math.fround(Math.min(v(a), v(b))))],
    ["__builtin_f32_max",     ([a, b]) => primitive(Math.fround(Math.max(v(a), v(b))))],

    // ── 浮動小数点演算（f64） ─────────────────────────────────────────────────
    ["__builtin_f64_abs",     ([a]) => primitive(Math.abs(v(a)))],
    ["__builtin_f64_sqrt",    ([a]) => primitive(Math.sqrt(v(a)))],
    ["__builtin_f64_floor",   ([a]) => primitive(Math.floor(v(a)))],
    ["__builtin_f64_ceil",    ([a]) => primitive(Math.ceil(v(a)))],
    ["__builtin_f64_trunc",   ([a]) => primitive(Math.trunc(v(a)))],
    ["__builtin_f64_nearest", ([a]) => primitive(Math.round(v(a)))],
    ["__builtin_f64_min",     ([a, b]) => primitive(Math.min(v(a), v(b)))],
    ["__builtin_f64_max",     ([a, b]) => primitive(Math.max(v(a), v(b)))],

    // ── 超越関数（予約済み命令、実装あり）────────────────────────────────────
    ["__builtin_f32_sin",  ([a]) => primitive(Math.fround(Math.sin(v(a))))],
    ["__builtin_f32_cos",  ([a]) => primitive(Math.fround(Math.cos(v(a))))],
    ["__builtin_f32_tan",  ([a]) => primitive(Math.fround(Math.tan(v(a))))],
    ["__builtin_f32_exp",  ([a]) => primitive(Math.fround(Math.exp(v(a))))],
    ["__builtin_f32_log",  ([a]) => primitive(Math.fround(Math.log(v(a))))],
    ["__builtin_f32_pow",  ([a, b]) => primitive(Math.fround(Math.pow(v(a), v(b))))],
    ["__builtin_f32_atan", ([a]) => primitive(Math.fround(Math.atan(v(a))))],
    ["__builtin_f32_atan2",([a, b]) => primitive(Math.fround(Math.atan2(v(a), v(b))))],
    ["__builtin_f64_sin",  ([a]) => primitive(Math.sin(v(a)))],
    ["__builtin_f64_cos",  ([a]) => primitive(Math.cos(v(a)))],
    ["__builtin_f64_tan",  ([a]) => primitive(Math.tan(v(a)))],
    ["__builtin_f64_exp",  ([a]) => primitive(Math.exp(v(a)))],
    ["__builtin_f64_log",  ([a]) => primitive(Math.log(v(a)))],
    ["__builtin_f64_pow",  ([a, b]) => primitive(Math.pow(v(a), v(b)))],
    ["__builtin_f64_atan", ([a]) => primitive(Math.atan(v(a)))],
    ["__builtin_f64_atan2",([a, b]) => primitive(Math.atan2(v(a), v(b)))],

    // ── 型変換 ────────────────────────────────────────────────────────────────
    ["__builtin_i32_to_f32", ([a]) => primitive(Math.fround(v(a) | 0))],
    ["__builtin_i32_to_u32", ([a]) => primitive((v(a) | 0) >>> 0)],
    ["__builtin_u32_to_f32", ([a]) => primitive(Math.fround(v(a) >>> 0))],
    ["__builtin_u32_to_i32", ([a]) => primitive((v(a) >>> 0) | 0)],
    ["__builtin_f32_to_i32", ([a]) => primitive(Math.trunc(v(a)) | 0)],
    ["__builtin_f32_to_u32", ([a]) => primitive(Math.trunc(v(a)) >>> 0)],
    ["__builtin_i32_to_i64", ([a]) => primitive(n64(toI64(v(a) | 0)))],
    ["__builtin_u32_to_u64", ([a]) => primitive(n64(toU64(v(a) >>> 0)))],
    ["__builtin_i64_to_i32", ([a]) => primitive(Number(BigInt.asIntN(32, toI64(v(a)))))],
    ["__builtin_u64_to_u32", ([a]) => primitive(Number(BigInt.asUintN(32, toU64(v(a)))))],
    ["__builtin_f32_to_f64", ([a]) => primitive(Math.fround(v(a)))],
    ["__builtin_f64_to_f32", ([a]) => primitive(Math.fround(v(a)))],
    ["__builtin_f64_to_i64", ([a]) => primitive(n64(toI64(Math.trunc(v(a)))))],
    ["__builtin_i64_to_f64", ([a]) => primitive(Number(toI64(v(a))))],
    ["__builtin_u64_to_f64", ([a]) => primitive(Number(toU64(v(a))))],
    ["__builtin_i32_to_f64", ([a]) => primitive(v(a) | 0)],
    ["__builtin_u32_to_f64", ([a]) => primitive(v(a) >>> 0)],

    // ── メモリ管理 ────────────────────────────────────────────────────────────
    ["__builtin_malloc", ([size]) => primitive(HeapManager.alloc(v(size)))],
    ["__builtin_free",   ([ptr])  => { HeapManager.free(v(ptr)); return voidValue(); }],
    ["__builtin_mem_read8",  ([ptr, off]) => HeapManager.read(v(ptr) + v(off))],
    ["__builtin_mem_read16", ([ptr, off]) => HeapManager.read(v(ptr) + v(off))],
    ["__builtin_mem_read32", ([ptr, off]) => HeapManager.read(v(ptr) + v(off))],
    ["__builtin_mem_read64", ([ptr, off]) => HeapManager.read(v(ptr) + v(off))],
    ["__builtin_mem_write8",  ([ptr, off, val]) => { HeapManager.write(v(ptr) + v(off), val); return voidValue(); }],
    ["__builtin_mem_write16", ([ptr, off, val]) => { HeapManager.write(v(ptr) + v(off), val); return voidValue(); }],
    ["__builtin_mem_write32", ([ptr, off, val]) => { HeapManager.write(v(ptr) + v(off), val); return voidValue(); }],
    ["__builtin_mem_write64", ([ptr, off, val]) => { HeapManager.write(v(ptr) + v(off), val); return voidValue(); }],
    ["__builtin_zeroinit", ([]) => primitive(0)],

    // ── 入出力 ────────────────────────────────────────────────────────────────
    ["__builtin_stdout_write",   ([s]) => { process.stdout.write(runtimeValueToString(s)); return voidValue(); }],
    ["__builtin_stderr_write",   ([s]) => { process.stderr.write(runtimeValueToString(s)); return voidValue(); }],
    ["__builtin_stdin_readline", ([])  => { throw new Error("__builtin_stdin_readline is not supported in this version"); }],

    // ── パニック ──────────────────────────────────────────────────────────────
    ["__builtin_panic", ([msg]) => { throw new PanicError(runtimeValueToString(msg)); }],

    // ── マルチスレッド（シングルスレッドシミュレーション） ────────────────────
    // mutex / condvar は no-op
    ["__builtin_mutex_create",      ([])       => primitive(ThreadManager.nextId())],
    ["__builtin_mutex_lock",        ([_m])     => voidValue()],
    ["__builtin_mutex_unlock",      ([_m])     => voidValue()],
    ["__builtin_condvar_create",    ([])       => primitive(ThreadManager.nextId())],
    ["__builtin_condvar_wait",      ([_c, _m]) => voidValue()],
    ["__builtin_condvar_signal",    ([_c])     => voidValue()],
    ["__builtin_condvar_broadcast", ([_c])     => voidValue()],

    // atomic は通常のヒープ読み書き（シングルスレッドなので競合なし）
    ["__builtin_atomic_load",      ([ptr])              => HeapManager.read(v(ptr))],
    ["__builtin_atomic_store",     ([ptr, val])         => { HeapManager.write(v(ptr), val); return voidValue(); }],
    ["__builtin_atomic_cas",       ([ptr, exp, des])    => {
        const cur = HeapManager.read(v(ptr)) as any;
        if (cur.value === v(exp)) { HeapManager.write(v(ptr), des); return primitive(1); }
        return primitive(0);
    }],
    ["__builtin_atomic_fetch_add", ([ptr, val]) => {
        const cur = HeapManager.read(v(ptr)) as any;
        HeapManager.write(v(ptr), primitive(cur.value + v(val)));
        return primitive(cur.value);
    }],
    ["__builtin_atomic_fetch_sub", ([ptr, val]) => {
        const cur = HeapManager.read(v(ptr)) as any;
        HeapManager.write(v(ptr), primitive(cur.value - v(val)));
        return primitive(cur.value);
    }],

    // __builtin_if / __builtin_while / __builtin_sizeof は evaluator で特別処理
] as [string, BuiltinFn][]);

// ── パニックエラー ─────────────────────────────────────────────────────────────

export class PanicError extends Error {
    constructor(message: string) {
        super(`[PANIC] ${message}`);
    }
}

// ── ヒープ管理 ─────────────────────────────────────────────────────────────────

export class HeapManager {
    private static heap: Map<number, RuntimeValue> = new Map();
    private static nextAddr: number = 1000; // 0 はヌルポインタ予約

    static alloc(size: number): number {
        const addr = this.nextAddr;
        this.nextAddr += Math.max(size, 0);
        return addr;
    }

    static free(addr: number): void {
        this.heap.delete(addr);
    }

    static read(addr: number): RuntimeValue {
        return this.heap.get(addr) ?? primitive(0);
    }

    static write(addr: number, value: RuntimeValue): void {
        this.heap.set(addr, value);
    }

    static reset(): void {
        this.heap = new Map();
        this.nextAddr = 1000;
    }
}

// ── スレッドマネージャー（シングルスレッドシミュレーション） ──────────────────

export class ThreadManager {
    private static tasks: Map<number, { fnName: string; args: RuntimeValue[] }> = new Map();
    private static pools: Map<number, { fnName: string; args: RuntimeValue[] }[]> = new Map();
    private static _nextId = 1;

    static nextId(): number { return this._nextId++; }

    static enqueue(fnName: string, args: RuntimeValue[]): number {
        const id = this._nextId++;
        this.tasks.set(id, { fnName, args });
        return id;
    }

    static joinTask(id: number, runner: (fnName: string, args: RuntimeValue[]) => void): void {
        const task = this.tasks.get(id);
        if (task) {
            runner(task.fnName, task.args);
            this.tasks.delete(id);
        }
    }

    static createPool(_size: number): number {
        const id = this._nextId++;
        this.pools.set(id, []);
        return id;
    }

    static submitToPool(poolId: number, fnName: string, args: RuntimeValue[]): void {
        this.pools.get(poolId)?.push({ fnName, args });
    }

    static waitPool(poolId: number, runner: (fnName: string, args: RuntimeValue[]) => void): void {
        for (const task of this.pools.get(poolId) ?? []) {
            runner(task.fnName, task.args);
        }
        this.pools.set(poolId, []);
    }

    static destroyPool(poolId: number): void {
        this.pools.delete(poolId);
    }
}

// ── RuntimeValue を文字列に変換（I/O用） ──────────────────────────────────────

export function runtimeValueToString(value: RuntimeValue): string {
    if (value.kind === "object" && value.className.split("<")[0] === "Array") {
        const length = value.fields["length"] as any;
        const ptr    = value.fields["ptr"]    as any;
        if (!length || !ptr) return "";

        const len: number = length.kind === "object"
            ? ((length.fields["bits"] as any)?.value ?? 0)
            : (length.value ?? 0);

        const ptrAddr: number = ptr.kind === "primitive"
            ? ptr.value
            : ((ptr.fields?.["bits"] as any)?.value ?? 0);

        let result = "";
        for (let i = 0; i < len; i++) {
            const charVal = HeapManager.read(ptrAddr + i * 4) as any;
            let codePoint: number;
            if (charVal.kind === "primitive") {
                codePoint = charVal.value;
            } else if (charVal.kind === "object") {
                codePoint = (charVal.fields?.["bits"] as any)?.value ?? 0;
            } else {
                codePoint = 0;
            }
            result += String.fromCodePoint(codePoint);
        }
        return result;
    }
    if (value.kind === "primitive") return String(value.value);
    if (value.kind === "void")      return "";
    return `[object ${(value as any).className}]`;
}
