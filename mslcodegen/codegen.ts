// mslcodegen/codegen.ts — GPU IR (.gpu.json) → Metal Shading Language (MSL) ソース生成
//
// 仕様:
//   - 入力:  compiler/gpulower.ts が出力する GPU IR (mozaicScriptGpu モジュール)
//   - 出力:  MSL ソース (Apple Metal 互換)
//
// 型対応 (GPU IR → MSL):
//   i32 → int          (32bit)
//   u32 → uint         (32bit)
//   f32 → float        (32bit)
//   i64 → long         (64bit signed)
//   u64 → ulong        (64bit unsigned)
//   f64 → double       (Apple Silicon の Compute では未サポート — float にフォールバック)
//   bool → bool
//   ptr<T> → device T* (storage buffer)
//
// バインディング (Metal):
//   kernel 関数の引数として渡す。binding インデックスは [[buffer(N)]] 属性。
//   ポインタ型: device T* [[buffer(N)]]
//   スカラー: constant T& [[buffer(N)]]
//
// 組み込み (Metal):
//   thread_position_in_grid       (uint3) → gpuGlobalIdXYZ
//   thread_position_in_threadgroup → gpuLocalIdXYZ
//   threadgroup_position_in_grid  → gpuWorkgroupIdXYZ
//   threads_per_threadgroup        → gpuWorkgroupSize* (= compile-time const)
//   threadgroup_barrier(mem_flags::mem_threadgroup) → gpuBarrier
//   threadgroup_barrier(mem_flags::mem_device)      → gpuStorageBarrier
//   atomic_fetch_add_explicit(...) → gpuAtomicAdd 等

interface GpuKernelIR {
    name: string;
    workgroupSize: [number, number, number];
    params: { name: string; type: string; binding: number }[];
    locals: { name: string; type: string }[];
    body: any[];
}
interface GpuModule {
    mozaicScriptGpu: string;
    kernels: GpuKernelIR[];
}

function mslScalar(t: string): string {
    switch (t) {
        case "i32": return "int";
        case "u32": return "uint";
        case "i64": return "long";
        case "u64": return "ulong";
        case "f32": return "float";
        case "f64": return "float";  // Metal Compute では double 未対応のため
        case "bool": return "bool";
    }
    return t;
}
function mslType(t: string): string {
    if (t.startsWith("ptr<")) {
        const inner = t.slice(4, -1);
        return `device ${mslScalar(inner)}*`;
    }
    return mslScalar(t);
}

const BUILTIN_MAP: Record<string, (args: string[]) => string> = {
    gpuGlobalIdX:        () => "__gid.x",
    gpuGlobalIdY:        () => "__gid.y",
    gpuGlobalIdZ:        () => "__gid.z",
    gpuLocalIdX:         () => "__lid.x",
    gpuLocalIdY:         () => "__lid.y",
    gpuLocalIdZ:         () => "__lid.z",
    gpuWorkgroupIdX:     () => "__wid.x",
    gpuWorkgroupIdY:     () => "__wid.y",
    gpuWorkgroupIdZ:     () => "__wid.z",
    gpuWorkgroupSize:    () => "__wgSizeX",
    gpuBarrier:          () => "threadgroup_barrier(mem_flags::mem_threadgroup)",
    gpuStorageBarrier:   () => "threadgroup_barrier(mem_flags::mem_device)",
    gpuAtomicAdd:        a => `atomic_fetch_add_explicit((device atomic_uint*)${a[0]}, ${a[1]}, memory_order_relaxed)`,
    gpuAtomicSub:        a => `atomic_fetch_sub_explicit((device atomic_uint*)${a[0]}, ${a[1]}, memory_order_relaxed)`,
    gpuAtomicMin:        a => `atomic_fetch_min_explicit((device atomic_uint*)${a[0]}, ${a[1]}, memory_order_relaxed)`,
    gpuAtomicMax:        a => `atomic_fetch_max_explicit((device atomic_uint*)${a[0]}, ${a[1]}, memory_order_relaxed)`,
    gpuCompareExchange:  a => `({ uint __exp = ${a[1]}; atomic_compare_exchange_weak_explicit((device atomic_uint*)${a[0]}, &__exp, ${a[2]}, memory_order_relaxed, memory_order_relaxed); __exp; })`,
    gpuAtomicLoad:       a => `atomic_load_explicit((device atomic_uint*)${a[0]}, memory_order_relaxed)`,
    gpuAtomicStore:      a => `atomic_store_explicit((device atomic_uint*)${a[0]}, ${a[1]}, memory_order_relaxed)`,
    gpuAtomicAddI32:     a => `atomic_fetch_add_explicit((device atomic_int*)${a[0]}, ${a[1]}, memory_order_relaxed)`,
    gpuAtomicSubI32:     a => `atomic_fetch_sub_explicit((device atomic_int*)${a[0]}, ${a[1]}, memory_order_relaxed)`,
    gpuAtomicMinI32:     a => `atomic_fetch_min_explicit((device atomic_int*)${a[0]}, ${a[1]}, memory_order_relaxed)`,
    gpuAtomicMaxI32:     a => `atomic_fetch_max_explicit((device atomic_int*)${a[0]}, ${a[1]}, memory_order_relaxed)`,
    gpuCompareExchangeI32: a => `({ int __exp = ${a[1]}; atomic_compare_exchange_weak_explicit((device atomic_int*)${a[0]}, &__exp, ${a[2]}, memory_order_relaxed, memory_order_relaxed); __exp; })`,
    gpuAtomicLoadI32:    a => `atomic_load_explicit((device atomic_int*)${a[0]}, memory_order_relaxed)`,
    gpuAtomicStoreI32:   a => `atomic_store_explicit((device atomic_int*)${a[0]}, ${a[1]}, memory_order_relaxed)`,
    gpuFma:              a => `fma(${a[0]}, ${a[1]}, ${a[2]})`,
    gpuDotF32x4:         a => `(${a[0]}[0]*${a[1]}[0]+${a[0]}[1]*${a[1]}[1]+${a[0]}[2]*${a[1]}[2]+${a[0]}[3]*${a[1]}[3])`,
};

class Emit {
    private out: string[] = [];
    private indent = 0;
    private localTypes = new Map<string, string>();

    constructor(private kernel: GpuKernelIR) {
        for (const l of kernel.locals) this.localTypes.set(l.name, l.type);
    }

    private push(line: string): void {
        this.out.push("    ".repeat(this.indent) + line);
    }
    private ind(): void { this.indent++; }
    private ded(): void { this.indent--; }

    emit(): string {
        const k = this.kernel;

        // kernel signature
        this.push(`kernel void ${k.name}(`);
        this.ind();
        const lines: string[] = [];
        for (const p of k.params) {
            if (p.type.startsWith("ptr<")) {
                lines.push(`${mslType(p.type)} ${p.name} [[buffer(${p.binding})]]`);
            } else {
                lines.push(`constant ${mslScalar(p.type)}& ${p.name} [[buffer(${p.binding})]]`);
            }
        }
        // builtin args (Metal injects these via attribute decorators)
        lines.push(`uint3 __gid [[thread_position_in_grid]]`);
        lines.push(`uint3 __lid [[thread_position_in_threadgroup]]`);
        lines.push(`uint3 __wid [[threadgroup_position_in_grid]]`);
        for (let i = 0; i < lines.length; i++) {
            this.push(lines[i] + (i < lines.length - 1 ? "," : ""));
        }
        this.ded();
        this.push(`) {`);
        this.ind();

        // ワークグループサイズはカーネルローカル定数として宣言 (同一ファイル内の衝突回避)
        this.push(`const uint __wgSizeX = ${k.workgroupSize[0]};`);

        // body
        for (const s of k.body) this.emitStmt(s);

        this.ded();
        this.push(`}`);
        return this.out.join("\n");
    }

    private emitStmt(n: any): void {
        if (!n) return;
        switch (n.type) {
            case "GpuVarDecl": {
                // GpuVarDecl は型を持たないので kernel.locals から解決
                const tRaw = this.localTypes.get(n.name) ?? "i32";
                const t = mslScalar(tRaw);
                this.push(`${t} ${n.name} = ${this.emitExpr(n.value)};`);
                break;
            }
            case "GpuAssign": {
                this.push(`${this.emitLValue(n.target)} = ${this.emitExpr(n.value)};`);
                break;
            }
            case "GpuIf": {
                this.push(`if (${this.emitExpr(n.cond)}) {`);
                this.ind();
                for (const s of n.then) this.emitStmt(s);
                this.ded();
                if (n.else && n.else.length > 0) {
                    this.push(`} else {`);
                    this.ind();
                    for (const s of n.else) this.emitStmt(s);
                    this.ded();
                }
                this.push(`}`);
                break;
            }
            case "GpuFor": {
                this.push(`for (uint ${(n.init as any).name} = ${this.emitExpr((n.init as any).value)}; ${this.emitExpr(n.cond)}; ) {`);
                this.ind();
                for (const s of n.body) this.emitStmt(s);
                this.emitStmt(n.update);
                this.ded();
                this.push(`}`);
                break;
            }
            case "GpuWhile": {
                this.push(`while (${this.emitExpr(n.cond)}) {`);
                this.ind();
                for (const s of n.body) this.emitStmt(s);
                this.ded();
                this.push(`}`);
                break;
            }
            case "GpuBreak": this.push(`break;`); break;
            case "GpuReturn": this.push(`return;`); break;
            case "GpuExprStmt":
                this.push(`${this.emitExpr(n.expr)};`);
                break;
        }
    }

    private emitLValue(n: any): string {
        switch (n.type) {
            case "GpuIdent": return n.name;
            case "GpuIndex": return `${this.emitExpr(n.base)}[${this.emitExpr(n.index)}]`;
            case "GpuField": return `${this.emitExpr(n.base)}.${n.field}`;
        }
        return "/* unsupported lvalue */";
    }

    private emitExpr(n: any): string {
        if (!n) return "0";
        switch (n.type) {
            case "GpuLiteral": {
                const t = n.valueType;
                if (t === "f32" || t === "f64") {
                    let s = String(n.value);
                    if (!s.includes(".") && !s.includes("e")) s += ".0";
                    return `${s}f`;
                }
                if (t === "u32" || t === "u64") return `${n.value | 0}u`;
                if (t === "bool") return n.value ? "true" : "false";
                return String(n.value | 0);
            }
            case "GpuIdent": return n.name;
            case "GpuBinOp":
                return `(${this.emitExpr(n.lhs)} ${n.op} ${this.emitExpr(n.rhs)})`;
            case "GpuUnaryOp":
                return `(${n.op}${this.emitExpr(n.expr)})`;
            case "GpuIndex":
                return `${this.emitExpr(n.base)}[${this.emitExpr(n.index)}]`;
            case "GpuField":
                return `${this.emitExpr(n.base)}.${n.field}`;
            case "GpuCallBuiltin": {
                const args = n.args.map((a: any) => this.emitExpr(a));
                const fn = BUILTIN_MAP[n.name];
                if (!fn) return `/* unsupported builtin ${n.name} */0`;
                return fn(args);
            }
        }
        return "/* unsupported expr */0";
    }
}

export function emitMsl(mod: GpuModule): string {
    const parts: string[] = [];
    parts.push("// generated by mozaicScript mslcodegen");
    parts.push(`// mozaicScriptGpu IR version: ${mod.mozaicScriptGpu}`);
    parts.push("#include <metal_stdlib>");
    parts.push("#include <metal_atomic>");
    parts.push("using namespace metal;");
    parts.push("");
    for (const k of mod.kernels) {
        parts.push(new Emit(k).emit());
        parts.push("");
    }
    return parts.join("\n");
}
