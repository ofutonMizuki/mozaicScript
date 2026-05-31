// wgslcodegen/codegen.ts — GPU IR (.gpu.json) → WGSL シェーダソース生成
//
// 仕様:
//   - 入力:  compiler/gpulower.ts が出力する GPU IR (mozaicScriptGpu モジュール)
//   - 出力:  WGSL ソース (WebGPU 互換)
//
// 型対応 (GPU IR → WGSL):
//   i32 / u32 / f32                  → 同名
//   bool                             → bool
//   ptr<T>                           → array<T>             (storage buffer)
//   array<T,N>                       → array<T, N>          (未対応: GPU IR 未生成)
//   struct:Name                      → 同名 (未対応)
//
// バインディングレイアウト (GPU IR 仕様 §3.1):
//   ポインタ型 (ptr<T>) は storage_buffer の read_write/read として bind
//   スカラー型 (i32/u32/f32) は単一フィールドの uniform struct として bind
//
// 組み込み関数 (GPU IR 仕様 §7):
//   gpuGlobalIdX/Y/Z, gpuLocalIdX/Y/Z, gpuWorkgroupIdX/Y/Z は @builtin 引数経由でアクセス
//   gpuBarrier → workgroupBarrier()
//   gpuStorageBarrier → storageBarrier()
//   gpuAtomic* → atomic ops (バッファ要素を atomic<u32> として宣言する必要あり)
//                簡略実装: 通常 array<u32> を使い atomicAdd() に渡す形では動作しない。
//                Atomic op を必要とするカーネルは別途バインディングを atomic<u32> 化する。
//   gpuFma → fma(), gpuDotF32x4 → dot4(...)

// ── GPU IR の型 (compiler/gpulower.ts と整合) ──
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

// ── WGSL 型変換 ──
function wgslType(t: string): string {
    if (t === "bool") return "bool";
    if (["i32", "u32", "i64", "u64", "f32", "f64"].includes(t)) {
        if (t === "i64") return "i32";  // WGSL は 64bit 整数を持たないので i32 にフォールバック
        if (t === "u64") return "u32";
        if (t === "f64") return "f32";
        return t;
    }
    if (t.startsWith("ptr<")) {
        const inner = t.slice(4, -1);
        return `array<${wgslType(inner)}>`;
    }
    return t;
}
// スカラー型の要素型 (ptr<T> から T を取り出す)
function ptrElem(t: string): string {
    if (t.startsWith("ptr<")) return wgslType(t.slice(4, -1));
    return wgslType(t);
}

// ── WGSL 組み込み呼び出し ──
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
    gpuWorkgroupSize:    () => "__wgSizeX",   // compile-time const
    gpuBarrier:          () => "workgroupBarrier()",
    gpuStorageBarrier:   () => "storageBarrier()",
    gpuAtomicAdd:        a => `atomicAdd(&${a[0]}, ${a[1]})`,
    gpuAtomicSub:        a => `atomicSub(&${a[0]}, ${a[1]})`,
    gpuAtomicMin:        a => `atomicMin(&${a[0]}, ${a[1]})`,
    gpuAtomicMax:        a => `atomicMax(&${a[0]}, ${a[1]})`,
    gpuCompareExchange:  a => `atomicCompareExchangeWeak(&${a[0]}, ${a[1]}, ${a[2]}).old_value`,
    gpuAtomicLoad:       a => `atomicLoad(&${a[0]})`,
    gpuAtomicStore:      a => `atomicStore(&${a[0]}, ${a[1]})`,
    gpuAtomicAddI32:     a => `atomicAdd(&${a[0]}, ${a[1]})`,
    gpuAtomicSubI32:     a => `atomicSub(&${a[0]}, ${a[1]})`,
    gpuAtomicMinI32:     a => `atomicMin(&${a[0]}, ${a[1]})`,
    gpuAtomicMaxI32:     a => `atomicMax(&${a[0]}, ${a[1]})`,
    gpuCompareExchangeI32: a => `atomicCompareExchangeWeak(&${a[0]}, ${a[1]}, ${a[2]}).old_value`,
    gpuAtomicLoadI32:    a => `atomicLoad(&${a[0]})`,
    gpuAtomicStoreI32:   a => `atomicStore(&${a[0]}, ${a[1]})`,
    gpuFma:              a => `fma(${a[0]}, ${a[1]}, ${a[2]})`,
    gpuDotF32x4:         a => `(${a[0]}[0]*${a[1]}[0]+${a[0]}[1]*${a[1]}[1]+${a[0]}[2]*${a[1]}[2]+${a[0]}[3]*${a[1]}[3])`,
};

class Emit {
    private out: string[] = [];
    private indent = 0;
    private wgSizeX = 64;
    private localTypes = new Map<string, string>();
    // 複数カーネルを 1 ファイルに集約する場合は per-kernel name prefix と
    // 別 @group インデックスでバインディング衝突を避ける。
    private prefix = "";
    private groupIdx = 0;

    constructor(private kernel: GpuKernelIR, groupIdx: number = 0) {
        this.wgSizeX = kernel.workgroupSize[0];
        for (const l of kernel.locals) this.localTypes.set(l.name, l.type);
        this.groupIdx = groupIdx;
        // groupIdx > 0 (= 複数カーネル) なら各 global にカーネル名 prefix を付ける
        this.prefix = groupIdx === 0 ? "" : `${kernel.name}_`;
    }

    private push(line: string): void {
        this.out.push("  ".repeat(this.indent) + line);
    }

    private ind(): void { this.indent++; }
    private ded(): void { this.indent--; }

    emit(): string {
        const k = this.kernel;
        const pre = this.prefix;
        const grp = this.groupIdx;
        // ── バインディング宣言 ──
        // ptr<T>: storage_buffer (read_write)
        // scalar: 単一フィールドの uniform struct
        const scalarStructFields: string[] = [];
        const scalarParams: string[] = [];
        for (const p of k.params) {
            if (p.type.startsWith("ptr<")) {
                const elem = ptrElem(p.type);
                this.push(`@group(${grp}) @binding(${p.binding}) var<storage, read_write> ${pre}${p.name}: array<${elem}>;`);
            } else {
                // スカラーは uniform struct の 1 フィールドとして集約
                scalarStructFields.push(`${p.name}: ${wgslType(p.type)},`);
                scalarParams.push(p.name);
            }
        }
        const scalarsName = `${pre}__scalars`;
        const scalarsT    = `${pre}__ScalarsT`;
        if (scalarStructFields.length > 0) {
            this.push("");
            this.push(`struct ${scalarsT} {`);
            this.ind();
            for (const f of scalarStructFields) this.push(f);
            this.ded();
            this.push(`};`);
            const maxBinding = Math.max(...k.params.map(p => p.binding), -1);
            this.push(`@group(${grp}) @binding(${maxBinding + 1}) var<uniform> ${scalarsName}: ${scalarsT};`);
        }
        this.push("");

        // ── カーネル関数 ──
        this.push(`@compute @workgroup_size(${k.workgroupSize[0]}, ${k.workgroupSize[1]}, ${k.workgroupSize[2]})`);
        this.push(`fn ${k.name}(`);
        this.ind();
        this.push(`@builtin(global_invocation_id) __gid: vec3<u32>,`);
        this.push(`@builtin(local_invocation_id) __lid: vec3<u32>,`);
        this.push(`@builtin(workgroup_id) __wid: vec3<u32>,`);
        this.ded();
        this.push(`) {`);
        this.ind();

        // ワークグループサイズはカーネルローカル定数として宣言 (複数カーネル時の衝突回避)
        this.push(`let __wgSizeX: u32 = ${this.wgSizeX}u;`);

        // スカラー引数をローカル alias 化
        for (const sp of scalarParams) {
            this.push(`let ${sp} = ${scalarsName}.${sp};`);
        }

        // ポインタ引数を local alias 化 (prefix 付きから名前なしで参照できるように)
        if (pre !== "") {
            for (const p of k.params) {
                if (!p.type.startsWith("ptr<")) continue;
                // var-bind: alias は WGSL では `var<storage, read_write>` をローカル指すことは不可
                // → 直接 prefix 付き名を式中で使うよう、emit 側で置換する
            }
        }

        // ── 文の生成 ──
        // 変数参照を prefix 付き名に書き換えるため一時的に IdRewrite を有効化
        this.rewriteIds = pre === "" ? null : new Set(k.params.filter(p => p.type.startsWith("ptr<")).map(p => p.name));
        for (const s of k.body) this.emitStmt(s);
        this.rewriteIds = null;

        this.ded();
        this.push(`}`);

        return this.out.join("\n");
    }

    // ポインタ引数を prefix 付き global 名に書き換えるためのセット
    private rewriteIds: Set<string> | null = null;
    private mapId(name: string): string {
        if (this.rewriteIds && this.rewriteIds.has(name)) return `${this.prefix}${name}`;
        return name;
    }

    private emitStmt(n: any): void {
        if (!n) return;
        switch (n.type) {
            case "GpuVarDecl": {
                // GpuVarDecl は型を持たないので kernel.locals から解決する
                const tRaw = this.localTypes.get(n.name) ?? "i32";
                const t = wgslType(tRaw);
                this.push(`var ${n.name}: ${t} = ${this.emitExpr(n.value)};`);
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
                this.push(`for (var ${(n.init as any).name}: u32 = ${this.emitExpr((n.init as any).value)}; ${this.emitExpr(n.cond)}; ) {`);
                this.ind();
                for (const s of n.body) this.emitStmt(s);
                this.emitStmt(n.update);
                this.ded();
                this.push(`}`);
                break;
            }
            case "GpuWhile": {
                this.push(`loop {`);
                this.ind();
                this.push(`if (!(${this.emitExpr(n.cond)})) { break; }`);
                for (const s of n.body) this.emitStmt(s);
                this.ded();
                this.push(`}`);
                break;
            }
            case "GpuBreak": this.push(`break;`); break;
            case "GpuReturn": this.push(`return;`); break;
            case "GpuExprStmt": {
                const e = this.emitExpr(n.expr);
                this.push(`${e};`);
                break;
            }
        }
    }

    private emitLValue(n: any): string {
        switch (n.type) {
            case "GpuIdent": return this.mapId(n.name);
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
            case "GpuIdent": return this.mapId(n.name);
            case "GpuBinOp": {
                const op = n.op;
                const lhs = this.emitExpr(n.lhs);
                const rhs = this.emitExpr(n.rhs);
                return `(${lhs} ${op} ${rhs})`;
            }
            case "GpuUnaryOp": {
                return `(${n.op}${this.emitExpr(n.expr)})`;
            }
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

// 単一カーネルの WGSL を出力する (推奨: WebGPU は 1 module = 1 kernel が扱いやすい)
export function emitWgslForKernel(mod: GpuModule, kernelName: string): string {
    const k = mod.kernels.find(k => k.name === kernelName);
    if (!k) throw new Error(`kernel '${kernelName}' not found in GPU IR`);
    return [
        `// generated by mozaicScript wgslcodegen`,
        `// mozaicScriptGpu IR version: ${mod.mozaicScriptGpu}`,
        `// kernel: ${kernelName}`,
        ``,
        new Emit(k).emit(),
        ``,
    ].join("\n");
}

// 全カーネルをまとめて 1 ファイルに出力する場合、各カーネルのバインディングは
// `@group(K)` で K = kernelIndex 単位に分離してコンフリクトを避ける。
// ※ 利用側 (host) は kernel ごとに対応する group index を bindGroup として作成すること。
export function emitWgsl(mod: GpuModule): string {
    const parts: string[] = [];
    parts.push(`// generated by mozaicScript wgslcodegen`);
    parts.push(`// mozaicScriptGpu IR version: ${mod.mozaicScriptGpu}`);
    parts.push("");
    for (let i = 0; i < mod.kernels.length; i++) {
        const k = mod.kernels[i];
        parts.push(new Emit(k, i).emit());
        parts.push("");
    }
    return parts.join("\n");
}
