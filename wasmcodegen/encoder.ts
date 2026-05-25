// wasmcodegen/encoder.ts — low-level WebAssembly binary encoder
//
// Provides LEB128 encoding, a FuncBuilder with opcode-emitting helpers (the
// instruction stream of one function body), and a ModuleBuilder that assembles
// the type / import / function / memory / global / export / code sections into a
// final binary .wasm module.

export type ValType = "i32" | "i64" | "f32" | "f64";

const VALTYPE: Record<ValType, number> = {
    i32: 0x7f,
    i64: 0x7e,
    f32: 0x7d,
    f64: 0x7c,
};

// ── LEB128 ──────────────────────────────────────────────────────────────────

export function uleb(n: number): number[] {
    const out: number[] = [];
    let v = n >>> 0; // treat as unsigned 32-bit (sizes/indices fit in 32 bits)
    do {
        let byte = v & 0x7f;
        v >>>= 7;
        if (v !== 0) byte |= 0x80;
        out.push(byte);
    } while (v !== 0);
    return out;
}

export function sleb(value: number | bigint): number[] {
    let v = typeof value === "bigint" ? value : BigInt(Math.trunc(value));
    const out: number[] = [];
    while (true) {
        let byte = Number(v & 0x7fn);
        v >>= 7n;
        const signBit = byte & 0x40;
        if ((v === 0n && !signBit) || (v === -1n && signBit)) {
            out.push(byte);
            break;
        }
        out.push(byte | 0x80);
    }
    return out;
}

function f32Bytes(x: number): number[] {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, x, true);
    return Array.from(b);
}
function f64Bytes(x: number): number[] {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, x, true);
    return Array.from(b);
}

// ── opcodes ───────────────────────────────────────────────────────────────────

export const OP = {
    unreachable: 0x00, nop: 0x01,
    block: 0x02, loop: 0x03, if: 0x04, else: 0x05, end: 0x0b,
    br: 0x0c, br_if: 0x0d, return: 0x0f, call: 0x10, call_indirect: 0x11,
    drop: 0x1a, select: 0x1b,
    local_get: 0x20, local_set: 0x21, local_tee: 0x22,
    global_get: 0x23, global_set: 0x24,
    i32_load: 0x28, i64_load: 0x29, f32_load: 0x2a, f64_load: 0x2b,
    i32_load8_s: 0x2c, i32_load8_u: 0x2d, i32_load16_s: 0x2e, i32_load16_u: 0x2f,
    i64_load8_s: 0x30, i64_load8_u: 0x31, i64_load16_s: 0x32, i64_load16_u: 0x33,
    i64_load32_s: 0x34, i64_load32_u: 0x35,
    i32_store: 0x36, i64_store: 0x37, f32_store: 0x38, f64_store: 0x39,
    i32_store8: 0x3a, i32_store16: 0x3b, i64_store8: 0x3c, i64_store16: 0x3d, i64_store32: 0x3e,
    memory_size: 0x3f, memory_grow: 0x40,
    i32_const: 0x41, i64_const: 0x42, f32_const: 0x43, f64_const: 0x44,
    i32_eqz: 0x45, i32_eq: 0x46, i32_ne: 0x47,
    i32_lt_s: 0x48, i32_lt_u: 0x49, i32_gt_s: 0x4a, i32_gt_u: 0x4b,
    i32_le_s: 0x4c, i32_le_u: 0x4d, i32_ge_s: 0x4e, i32_ge_u: 0x4f,
    i64_eqz: 0x50, i64_eq: 0x51, i64_ne: 0x52,
    i64_lt_s: 0x53, i64_lt_u: 0x54, i64_gt_s: 0x55, i64_gt_u: 0x56,
    i64_le_s: 0x57, i64_le_u: 0x58, i64_ge_s: 0x59, i64_ge_u: 0x5a,
    f32_eq: 0x5b, f32_ne: 0x5c, f32_lt: 0x5d, f32_gt: 0x5e, f32_le: 0x5f, f32_ge: 0x60,
    f64_eq: 0x61, f64_ne: 0x62, f64_lt: 0x63, f64_gt: 0x64, f64_le: 0x65, f64_ge: 0x66,
    i32_clz: 0x67, i32_ctz: 0x68, i32_popcnt: 0x69,
    i32_add: 0x6a, i32_sub: 0x6b, i32_mul: 0x6c, i32_div_s: 0x6d, i32_div_u: 0x6e,
    i32_rem_s: 0x6f, i32_rem_u: 0x70, i32_and: 0x71, i32_or: 0x72, i32_xor: 0x73,
    i32_shl: 0x74, i32_shr_s: 0x75, i32_shr_u: 0x76, i32_rotl: 0x77, i32_rotr: 0x78,
    i64_clz: 0x79, i64_ctz: 0x7a, i64_popcnt: 0x7b,
    i64_add: 0x7c, i64_sub: 0x7d, i64_mul: 0x7e, i64_div_s: 0x7f, i64_div_u: 0x80,
    i64_rem_s: 0x81, i64_rem_u: 0x82, i64_and: 0x83, i64_or: 0x84, i64_xor: 0x85,
    i64_shl: 0x86, i64_shr_s: 0x87, i64_shr_u: 0x88, i64_rotl: 0x89, i64_rotr: 0x8a,
    f32_abs: 0x8b, f32_neg: 0x8c, f32_ceil: 0x8d, f32_floor: 0x8e, f32_trunc: 0x8f,
    f32_nearest: 0x90, f32_sqrt: 0x91, f32_add: 0x92, f32_sub: 0x93, f32_mul: 0x94,
    f32_div: 0x95, f32_min: 0x96, f32_max: 0x97, f32_copysign: 0x98,
    f64_abs: 0x99, f64_neg: 0x9a, f64_ceil: 0x9b, f64_floor: 0x9c, f64_trunc: 0x9d,
    f64_nearest: 0x9e, f64_sqrt: 0x9f, f64_add: 0xa0, f64_sub: 0xa1, f64_mul: 0xa2,
    f64_div: 0xa3, f64_min: 0xa4, f64_max: 0xa5, f64_copysign: 0xa6,
    i32_wrap_i64: 0xa7,
    i32_trunc_f32_s: 0xa8, i32_trunc_f32_u: 0xa9, i32_trunc_f64_s: 0xaa, i32_trunc_f64_u: 0xab,
    i64_extend_i32_s: 0xac, i64_extend_i32_u: 0xad,
    i64_trunc_f32_s: 0xae, i64_trunc_f32_u: 0xaf, i64_trunc_f64_s: 0xb0, i64_trunc_f64_u: 0xb1,
    f32_convert_i32_s: 0xb2, f32_convert_i32_u: 0xb3, f32_convert_i64_s: 0xb4, f32_convert_i64_u: 0xb5,
    f32_demote_f64: 0xb6,
    f64_convert_i32_s: 0xb7, f64_convert_i32_u: 0xb8, f64_convert_i64_s: 0xb9, f64_convert_i64_u: 0xba,
    f64_promote_f32: 0xbb,
    i32_reinterpret_f32: 0xbc, i64_reinterpret_f64: 0xbd,
    f32_reinterpret_i32: 0xbe, f64_reinterpret_i64: 0xbf,
} as const;

// block type: 0x40 = void
const BLOCK_VOID = 0x40;

// ── FuncBuilder ────────────────────────────────────────────────────────────────

export class FuncBuilder {
    code: number[] = [];
    // locals declared after the params (params occupy the first indices)
    localTypes: ValType[] = [];
    paramCount: number;

    constructor(public params: ValType[], public results: ValType[]) {
        this.paramCount = params.length;
    }

    addLocal(t: ValType): number {
        const idx = this.paramCount + this.localTypes.length;
        this.localTypes.push(t);
        return idx;
    }

    private op(b: number): this { this.code.push(b); return this; }
    raw(...bytes: number[]): this { for (const b of bytes) this.code.push(b); return this; }

    // constants
    i32_const(n: number): this { this.op(OP.i32_const); this.code.push(...sleb(n | 0)); return this; }
    i32_const_u(n: number): this { this.op(OP.i32_const); this.code.push(...sleb(n >>> 0 > 0x7fffffff ? (n >>> 0) - 0x100000000 : n >>> 0)); return this; }
    i64_const(n: number | bigint): this { this.op(OP.i64_const); this.code.push(...sleb(n)); return this; }
    f32_const(x: number): this { this.op(OP.f32_const); this.code.push(...f32Bytes(x)); return this; }
    f64_const(x: number): this { this.op(OP.f64_const); this.code.push(...f64Bytes(x)); return this; }

    // locals / globals
    local_get(i: number): this { this.op(OP.local_get); this.code.push(...uleb(i)); return this; }
    local_set(i: number): this { this.op(OP.local_set); this.code.push(...uleb(i)); return this; }
    local_tee(i: number): this { this.op(OP.local_tee); this.code.push(...uleb(i)); return this; }
    global_get(i: number): this { this.op(OP.global_get); this.code.push(...uleb(i)); return this; }
    global_set(i: number): this { this.op(OP.global_set); this.code.push(...uleb(i)); return this; }

    // memory access: align is the alignment hint exponent, offset is a byte offset
    load(opcode: number, align: number, offset: number): this {
        this.op(opcode); this.code.push(...uleb(align)); this.code.push(...uleb(offset)); return this;
    }
    store(opcode: number, align: number, offset: number): this {
        this.op(opcode); this.code.push(...uleb(align)); this.code.push(...uleb(offset)); return this;
    }
    memory_size(): this { this.op(OP.memory_size); this.code.push(0x00); return this; }
    memory_grow(): this { this.op(OP.memory_grow); this.code.push(0x00); return this; }

    // control flow
    block_void(): this { this.op(OP.block); this.code.push(BLOCK_VOID); return this; }
    block_t(t: ValType): this { this.op(OP.block); this.code.push(VALTYPE[t]); return this; }
    loop_void(): this { this.op(OP.loop); this.code.push(BLOCK_VOID); return this; }
    if_void(): this { this.op(OP.if); this.code.push(BLOCK_VOID); return this; }
    if_t(t: ValType): this { this.op(OP.if); this.code.push(VALTYPE[t]); return this; }
    else_(): this { return this.op(OP.else); }
    end(): this { return this.op(OP.end); }
    br(depth: number): this { this.op(OP.br); this.code.push(...uleb(depth)); return this; }
    br_if(depth: number): this { this.op(OP.br_if); this.code.push(...uleb(depth)); return this; }
    return_(): this { return this.op(OP.return); }
    call(funcIdx: number): this { this.op(OP.call); this.code.push(...uleb(funcIdx)); return this; }
    drop(): this { return this.op(OP.drop); }
    unreachable(): this { return this.op(OP.unreachable); }

    // bare opcode (for the many no-immediate numeric ops)
    emit(opcode: number): this { return this.op(opcode); }

    // finished body bytes = locals decl + code + end
    finish(): number[] {
        const out: number[] = [];
        // run-length encode locals by type
        const runs: { t: ValType; n: number }[] = [];
        for (const t of this.localTypes) {
            const last = runs[runs.length - 1];
            if (last && last.t === t) last.n++;
            else runs.push({ t, n: 1 });
        }
        out.push(...uleb(runs.length));
        for (const r of runs) {
            out.push(...uleb(r.n));
            out.push(VALTYPE[r.t]);
        }
        out.push(...this.code);
        out.push(OP.end);
        return out;
    }
}

// ── ModuleBuilder ──────────────────────────────────────────────────────────────

interface FuncType { params: ValType[]; results: ValType[]; }
interface ImportEntry { module: string; name: string; typeIdx: number; }
interface DefinedFunc { typeIdx: number; body: FuncBuilder; }
interface ExportEntry { name: string; kind: number; index: number; }
interface GlobalEntry { type: ValType; mutable: boolean; init: number[]; }

export class ModuleBuilder {
    private types: FuncType[] = [];
    private imports: ImportEntry[] = [];
    private funcs: DefinedFunc[] = [];
    private exports: ExportEntry[] = [];
    private globals: GlobalEntry[] = [];
    private memMin = 16;
    private memMax: number | undefined = undefined;

    setMemory(minPages: number, maxPages?: number): void {
        this.memMin = minPages;
        this.memMax = maxPages;
    }

    addType(params: ValType[], results: ValType[]): number {
        const key = `${params.join(",")}|${results.join(",")}`;
        for (let i = 0; i < this.types.length; i++) {
            const t = this.types[i];
            if (`${t.params.join(",")}|${t.results.join(",")}` === key) return i;
        }
        this.types.push({ params, results });
        return this.types.length - 1;
    }

    // returns the function index of the import (imports occupy the low indices)
    addImport(module: string, name: string, params: ValType[], results: ValType[]): number {
        const typeIdx = this.addType(params, results);
        const idx = this.imports.length;
        this.imports.push({ module, name, typeIdx });
        return idx;
    }

    importCount(): number { return this.imports.length; }

    // index that the next defined function will occupy
    nextFuncIndex(): number { return this.imports.length + this.funcs.length; }

    addFunc(fb: FuncBuilder): number {
        const typeIdx = this.addType(fb.params, fb.results);
        const idx = this.imports.length + this.funcs.length;
        this.funcs.push({ typeIdx, body: fb });
        return idx;
    }

    addGlobal(type: ValType, mutable: boolean, initI32: number): number {
        const init = [OP.i32_const, ...sleb(initI32 | 0)];
        this.globals.push({ type, mutable, init });
        return this.globals.length - 1;
    }

    // declare a mutable global initialized to the zero value of its type
    addGlobalZero(type: ValType): number {
        let init: number[];
        switch (type) {
            case "i64": init = [OP.i64_const, ...sleb(0)]; break;
            case "f32": init = [OP.f32_const, 0, 0, 0, 0]; break;
            case "f64": init = [OP.f64_const, 0, 0, 0, 0, 0, 0, 0, 0]; break;
            default: init = [OP.i32_const, ...sleb(0)]; break;
        }
        this.globals.push({ type, mutable: true, init });
        return this.globals.length - 1;
    }

    exportFunc(name: string, funcIdx: number): void {
        this.exports.push({ name, kind: 0x00, index: funcIdx });
    }
    exportMemory(name: string): void {
        this.exports.push({ name, kind: 0x02, index: 0 });
    }

    private section(id: number, payload: number[]): number[] {
        return [id, ...uleb(payload.length), ...payload];
    }

    private encodeName(s: string): number[] {
        // names used here (module/field/export) are ASCII
        const bytes: number[] = [];
        for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i) & 0x7f);
        return [...uleb(bytes.length), ...bytes];
    }

    encode(): Uint8Array {
        const out: number[] = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

        // type section (1)
        {
            const p: number[] = [...uleb(this.types.length)];
            for (const t of this.types) {
                p.push(0x60);
                p.push(...uleb(t.params.length), ...t.params.map(v => VALTYPE[v]));
                p.push(...uleb(t.results.length), ...t.results.map(v => VALTYPE[v]));
            }
            out.push(...this.section(1, p));
        }

        // import section (2)
        if (this.imports.length > 0) {
            const p: number[] = [...uleb(this.imports.length)];
            for (const imp of this.imports) {
                p.push(...this.encodeName(imp.module));
                p.push(...this.encodeName(imp.name));
                p.push(0x00); // func import
                p.push(...uleb(imp.typeIdx));
            }
            out.push(...this.section(2, p));
        }

        // function section (3)
        {
            const p: number[] = [...uleb(this.funcs.length)];
            for (const f of this.funcs) p.push(...uleb(f.typeIdx));
            out.push(...this.section(3, p));
        }

        // memory section (5)
        {
            const p: number[] = [...uleb(1)];
            if (this.memMax !== undefined) {
                p.push(0x01, ...uleb(this.memMin), ...uleb(this.memMax));
            } else {
                p.push(0x00, ...uleb(this.memMin));
            }
            out.push(...this.section(5, p));
        }

        // global section (6)
        if (this.globals.length > 0) {
            const p: number[] = [...uleb(this.globals.length)];
            for (const g of this.globals) {
                p.push(VALTYPE[g.type], g.mutable ? 0x01 : 0x00);
                p.push(...g.init, OP.end);
            }
            out.push(...this.section(6, p));
        }

        // export section (7)
        {
            const p: number[] = [...uleb(this.exports.length)];
            for (const e of this.exports) {
                p.push(...this.encodeName(e.name));
                p.push(e.kind, ...uleb(e.index));
            }
            out.push(...this.section(7, p));
        }

        // code section (10)
        {
            const p: number[] = [...uleb(this.funcs.length)];
            for (const f of this.funcs) {
                const body = f.body.finish();
                p.push(...uleb(body.length), ...body);
            }
            out.push(...this.section(10, p));
        }

        return Uint8Array.from(out);
    }
}
