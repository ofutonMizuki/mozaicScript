import { RuntimeValue, primitive, voidValue, ObjectValue } from "./values";

type BuiltinFn = (args: RuntimeValue[]) => RuntimeValue;

export const builtins: Map<string, BuiltinFn> = new Map([

    // i32 算術
    ["__builtin_i32_add", ([a, b]) => primitive(((a as any).value + (b as any).value) | 0)],
    ["__builtin_i32_sub", ([a, b]) => primitive(((a as any).value - (b as any).value) | 0)],
    ["__builtin_i32_mul", ([a, b]) => primitive(Math.imul((a as any).value, (b as any).value))],
    ["__builtin_i32_div", ([a, b]) => primitive(((a as any).value / (b as any).value) | 0)],
    ["__builtin_i32_mod", ([a, b]) => primitive(((a as any).value % (b as any).value) | 0)],
    ["__builtin_i32_eq",  ([a, b]) => primitive((a as any).value === (b as any).value ? 1 : 0)],
    ["__builtin_i32_lt",  ([a, b]) => primitive((a as any).value < (b as any).value ? 1 : 0)],
    ["__builtin_i32_gt",  ([a, b]) => primitive((a as any).value > (b as any).value ? 1 : 0)],
    ["__builtin_i32_neg", ([a])    => primitive((-(a as any).value) | 0)],

    // u32 算術
    ["__builtin_u32_add", ([a, b]) => primitive(((a as any).value + (b as any).value) >>> 0)],
    ["__builtin_u32_sub", ([a, b]) => primitive(((a as any).value - (b as any).value) >>> 0)],
    ["__builtin_u32_mul", ([a, b]) => primitive(Math.imul((a as any).value, (b as any).value) >>> 0)],
    ["__builtin_u32_div", ([a, b]) => primitive(((a as any).value / (b as any).value) >>> 0)],
    ["__builtin_u32_mod", ([a, b]) => primitive(((a as any).value % (b as any).value) >>> 0)],
    ["__builtin_u32_eq",  ([a, b]) => primitive((a as any).value === (b as any).value ? 1 : 0)],
    ["__builtin_u32_lt",  ([a, b]) => primitive(((a as any).value >>> 0) < ((b as any).value >>> 0) ? 1 : 0)],
    ["__builtin_u32_gt",  ([a, b]) => primitive(((a as any).value >>> 0) > ((b as any).value >>> 0) ? 1 : 0)],

    // f32 算術
    ["__builtin_f32_add", ([a, b]) => primitive(Math.fround((a as any).value + (b as any).value))],
    ["__builtin_f32_sub", ([a, b]) => primitive(Math.fround((a as any).value - (b as any).value))],
    ["__builtin_f32_mul", ([a, b]) => primitive(Math.fround((a as any).value * (b as any).value))],
    ["__builtin_f32_div", ([a, b]) => primitive(Math.fround((a as any).value / (b as any).value))],
    ["__builtin_f32_mod", ([a, b]) => primitive(Math.fround((a as any).value % (b as any).value))],
    ["__builtin_f32_eq",  ([a, b]) => primitive((a as any).value === (b as any).value ? 1 : 0)],
    ["__builtin_f32_lt",  ([a, b]) => primitive((a as any).value < (b as any).value ? 1 : 0)],
    ["__builtin_f32_gt",  ([a, b]) => primitive((a as any).value > (b as any).value ? 1 : 0)],
    ["__builtin_f32_neg", ([a])    => primitive(Math.fround(-(a as any).value))],

    // 論理演算
    ["__builtin_i32_or",  ([a, b]) => primitive((a as any).value | (b as any).value)],
    ["__builtin_i32_and", ([a, b]) => primitive((a as any).value & (b as any).value)],
    ["__builtin_i32_not", ([a])    => primitive((a as any).value === 0 ? 1 : 0)],

    // 型変換
    ["__builtin_i32_to_f32", ([a]) => primitive(Math.fround((a as any).value))],
    ["__builtin_i32_to_u32", ([a]) => primitive((a as any).value >>> 0)],
    ["__builtin_u32_to_f32", ([a]) => primitive(Math.fround((a as any).value >>> 0))],
    ["__builtin_u32_to_i32", ([a]) => primitive((a as any).value | 0)],
    ["__builtin_f32_to_i32", ([a]) => primitive(Math.trunc((a as any).value) | 0)],
    ["__builtin_f32_to_u32", ([a]) => primitive(Math.trunc((a as any).value) >>> 0)],

    // メモリ管理
    ["__builtin_malloc", ([size]) => {
        const addr = HeapManager.alloc((size as any).value);
        return primitive(addr);
    }],
    ["__builtin_free", ([ptr]) => {
        HeapManager.free((ptr as any).value);
        return voidValue();
    }],
    ["__builtin_mem_read32", ([ptr, offset]) => {
        return HeapManager.read((ptr as any).value + (offset as any).value);
    }],
    ["__builtin_mem_write32", ([ptr, offset, value]) => {
        HeapManager.write((ptr as any).value + (offset as any).value, value);
        return voidValue();
    }],
    ["__builtin_zeroinit", ([]) => primitive(0)],

    // 入出力
    ["__builtin_stdout_write", ([s]) => {
        process.stdout.write(runtimeValueToString(s));
        return voidValue();
    }],
    ["__builtin_stderr_write", ([s]) => {
        process.stderr.write(runtimeValueToString(s));
        return voidValue();
    }],
    ["__builtin_stdin_readline", ([]) => {
        throw new Error("__builtin_stdin_readline is not supported in this version");
    }],

    // パニック
    ["__builtin_panic", ([msg]) => {
        throw new PanicError(runtimeValueToString(msg));
    }],

    // __builtin_if / __builtin_while / __builtin_sizeof は evaluator で特別処理
]);

export class PanicError extends Error {
    constructor(message: string) {
        super(`[PANIC] ${message}`);
    }
}

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

// RuntimeValue を文字列に変換（__builtin_stdout_write 等で使用）
export function runtimeValueToString(value: RuntimeValue): string {
    if (value.kind === "object" && value.className.split("<")[0] === "Array") {
        const length = value.fields.get("length") as any;
        const ptr = value.fields.get("ptr") as any;
        if (!length || !ptr) return "";

        // length は i32 ObjectValue（fields.bits）またはそのまま PrimitiveValue
        const len: number = length.kind === "object"
            ? ((length.fields.get("bits") as any)?.value ?? 0)
            : (length.value ?? 0);

        // ptr は _m32 PrimitiveValue
        const ptrAddr: number = ptr.kind === "primitive"
            ? ptr.value
            : ((ptr.fields?.get("bits") as any)?.value ?? 0);

        let result = "";
        for (let i = 0; i < len; i++) {
            const charVal = HeapManager.read(ptrAddr + i * 4) as any;
            let codePoint: number;
            if (charVal.kind === "primitive") {
                codePoint = charVal.value;
            } else if (charVal.kind === "object") {
                // u32 / char ObjectValue
                codePoint = (charVal.fields?.get("bits") as any)?.value ?? 0;
            } else {
                codePoint = 0;
            }
            result += String.fromCodePoint(codePoint);
        }
        return result;
    }
    if (value.kind === "primitive") return String(value.value);
    if (value.kind === "void") return "";
    return `[object ${(value as any).className}]`;
}
