// compiler/gpulower.ts — CPU 側 IR の gpu FunctionDecl を GPU IR (.gpu.json) に lower する。
//
// 仕様: doc/mozaicScript-ir-spec.md Part 2 (GPU IR §G1〜G9)
//
// 入力: チェッカーが出力した IR ノード列のうち isGpu=true の FunctionDecl
// 出力: { mozaicScriptGpu: "1.0", kernels: GpuKernelIR[] }

import * as IR from '../interpreter/types';

export interface GpuKernelIR {
    name: string;
    workgroupSize: [number, number, number];
    params: { name: string; type: string; binding: number }[];
    locals: { name: string; type: string }[];
    body: any[];
}

export interface GpuModule {
    mozaicScriptGpu: string;
    kernels: GpuKernelIR[];
}

// ── 型マッピング ──────────────────────────────────────────────────────────
// mozaicScript の wrapper 型名 → GPU IR スカラー型
function mapType(t: string): string {
    if (t === 'boolean') return 'bool';
    if (['i32', 'u32', 'i64', 'u64', 'f32', 'f64'].includes(t)) return t;
    if (t.startsWith('Ptr<')) {
        const inner = t.slice(4, -1);
        return `ptr<${mapType(inner)}>`;
    }
    if (t.startsWith('Array<')) {
        const inner = t.slice(6, -1);
        return `ptr<${mapType(inner)}>`;
    }
    // void / unknown はそのまま
    return t;
}

// ── ロワリング本体 ────────────────────────────────────────────────────────

class Lower {
    locals: { name: string; type: string }[] = [];
    constructor(private kernelName: string) {}

    private err(msg: string): never {
        throw new Error(`GPU IR lowering error in kernel '${this.kernelName}': ${msg}`);
    }

    private addLocal(name: string, type: string): void {
        // ループ変数等が複数 scope で同名で出現してもいったん最初の出現だけ記録する
        if (!this.locals.some(l => l.name === name)) {
            this.locals.push({ name, type });
        }
    }

    // §6 式の lower
    lowerExpr(n: IR.ASTNode): any {
        switch (n.type) {
            case 'Identifier':
                return { type: 'GpuIdent', name: n.name, resolvedType: mapType(n.resolvedType) };

            case 'BorrowExpr':
                // GPU IR には参照型がない (ポインタは値渡し)。中身を返す。
                return this.lowerExpr(n.expr);

            case 'RawLiteral':
                // RawLiteral 単独はリテラルコンテキスト外でのみ NewExpr 内に現れるはずだが、
                // 念のため整数として扱う
                return { type: 'GpuLiteral', valueType: 'u32', value: n.value };

            case 'NewExpr': {
                // new <Wrapper>(literal) → GpuLiteral
                const t = n.resolvedType;
                if (n.args.length === 1 && n.args[0].type === 'RawLiteral') {
                    const lit = n.args[0] as IR.RawLiteral;
                    const vt = mapType(t);
                    return { type: 'GpuLiteral', valueType: vt, value: lit.value };
                }
                // new <Wrapper>(expr) → ラッパー値の生成 = 内側の式そのまま
                if (n.args.length === 1) {
                    return this.lowerExpr(n.args[0]);
                }
                this.err(`サポートされていない new 式: ${t}`);
            }

            case 'MemberAccess': {
                // .bits は raw 値へのアンボックス → 内側そのまま
                if (n.member === 'bits') return this.lowerExpr(n.receiver);
                return { type: 'GpuField', base: this.lowerExpr(n.receiver), field: n.member, resolvedType: mapType(n.resolvedType) };
            }

            case 'Intrinsic': {
                // §14.4 GPU builtin への lower
                const map: Record<string, { name: string; ret: string }> = {
                    __builtin_gpu_thread_global_id_x: { name: 'gpuGlobalIdX', ret: 'u32' },
                    __builtin_gpu_thread_global_id_y: { name: 'gpuGlobalIdY', ret: 'u32' },
                    __builtin_gpu_thread_global_id_z: { name: 'gpuGlobalIdZ', ret: 'u32' },
                    __builtin_gpu_thread_local_id_x:  { name: 'gpuLocalIdX',  ret: 'u32' },
                    __builtin_gpu_thread_local_id_y:  { name: 'gpuLocalIdY',  ret: 'u32' },
                    __builtin_gpu_thread_local_id_z:  { name: 'gpuLocalIdZ',  ret: 'u32' },
                    __builtin_gpu_thread_workgroup_id_x: { name: 'gpuWorkgroupIdX', ret: 'u32' },
                    __builtin_gpu_thread_workgroup_id_y: { name: 'gpuWorkgroupIdY', ret: 'u32' },
                    __builtin_gpu_thread_workgroup_id_z: { name: 'gpuWorkgroupIdZ', ret: 'u32' },
                    __builtin_gpu_thread_workgroup_size: { name: 'gpuWorkgroupSize', ret: 'u32' },
                    __builtin_gpu_barrier:         { name: 'gpuBarrier',         ret: 'void' },
                    __builtin_gpu_storage_barrier: { name: 'gpuStorageBarrier', ret: 'void' },
                    __builtin_gpu_atomic_add_u32:   { name: 'gpuAtomicAdd',   ret: 'u32' },
                    __builtin_gpu_atomic_sub_u32:   { name: 'gpuAtomicSub',   ret: 'u32' },
                    __builtin_gpu_atomic_min_u32:   { name: 'gpuAtomicMin',   ret: 'u32' },
                    __builtin_gpu_atomic_max_u32:   { name: 'gpuAtomicMax',   ret: 'u32' },
                    __builtin_gpu_atomic_cas_u32:   { name: 'gpuCompareExchange',   ret: 'u32' },
                    __builtin_gpu_atomic_load_u32:  { name: 'gpuAtomicLoad',  ret: 'u32' },
                    __builtin_gpu_atomic_store_u32: { name: 'gpuAtomicStore', ret: 'void' },
                    __builtin_gpu_atomic_add_i32:   { name: 'gpuAtomicAddI32',   ret: 'i32' },
                    __builtin_gpu_atomic_sub_i32:   { name: 'gpuAtomicSubI32',   ret: 'i32' },
                    __builtin_gpu_atomic_min_i32:   { name: 'gpuAtomicMinI32',   ret: 'i32' },
                    __builtin_gpu_atomic_max_i32:   { name: 'gpuAtomicMaxI32',   ret: 'i32' },
                    __builtin_gpu_atomic_cas_i32:   { name: 'gpuCompareExchangeI32',   ret: 'i32' },
                    __builtin_gpu_atomic_load_i32:  { name: 'gpuAtomicLoadI32',  ret: 'i32' },
                    __builtin_gpu_atomic_store_i32: { name: 'gpuAtomicStoreI32', ret: 'void' },
                    __builtin_gpu_fma:       { name: 'gpuFma',       ret: 'f32' },
                    __builtin_gpu_dot_f32x4: { name: 'gpuDotF32x4', ret: 'f32' },
                };
                const m = map[n.name];
                if (!m) {
                    // __builtin_if / __builtin_while はラッパー condition の脱糖。中身そのまま返す。
                    if (n.name === '__builtin_if' || n.name === '__builtin_while') {
                        return this.lowerExpr(n.args[0]);
                    }
                    this.err(`未知の intrinsic '${n.name}' を GPU IR に lower できません`);
                }
                return {
                    type: 'GpuCallBuiltin', name: m.name,
                    args: n.args.map(a => this.lowerExpr(a)),
                    resolvedType: m.ret,
                };
            }

            case 'MethodCall': {
                // 二項演算子
                const binOps: Record<string, string> = {
                    'operator+': '+', 'operator-': '-', 'operator*': '*',
                    'operator/': '/', 'operator%': '%',
                    'operator==': '==', 'operator<': '<', 'operator>': '>',
                    'operator&&': '&&', 'operator||': '||',
                };
                if (binOps[n.method]) {
                    if (n.args.length !== 1) this.err(`二項演算子 ${n.method} の引数数が不正`);
                    return {
                        type: 'GpuBinOp', op: binOps[n.method],
                        lhs: this.lowerExpr(n.receiver),
                        rhs: this.lowerExpr(n.args[0]),
                        resolvedType: mapType(n.resolvedType),
                    };
                }
                if (n.method === 'operatorNot') {
                    return {
                        type: 'GpuUnaryOp', op: '!',
                        expr: this.lowerExpr(n.receiver),
                        resolvedType: mapType(n.resolvedType),
                    };
                }
                if (n.method === 'negate') {
                    return {
                        type: 'GpuUnaryOp', op: '-',
                        expr: this.lowerExpr(n.receiver),
                        resolvedType: mapType(n.resolvedType),
                    };
                }
                if (n.method === 'operator[]') {
                    return {
                        type: 'GpuIndex',
                        base: this.lowerExpr(n.receiver),
                        index: this.lowerExpr(n.args[0]),
                        resolvedType: mapType(n.resolvedType),
                    };
                }
                // 残りはユーザ関数呼び出し相当 → §14.3.2 で拒否済みのはず
                this.err(`GPU IR では未対応のメソッド呼び出し '${n.method}'`);
            }
        }
        this.err(`未対応の式ノード '${(n as any).type}'`);
    }

    // §5 文の lower
    lowerStmt(n: IR.ASTNode): any | null {
        switch (n.type) {
            case 'VarDecl': {
                const t = mapType(n.resolvedType);
                this.addLocal(n.name, t);
                return { type: 'GpuVarDecl', name: n.name, value: this.lowerExpr(n.value) };
            }
            case 'Assign': {
                let target: any;
                if (n.target.type === 'Identifier') {
                    target = { type: 'GpuIdent', name: n.target.name };
                } else if (n.target.type === 'MemberAccess') {
                    target = { type: 'GpuField', base: this.lowerExpr(n.target.receiver), field: n.target.member };
                } else {
                    this.err(`未対応の代入先 ${(n.target as any).type}`);
                }
                return { type: 'GpuAssign', target, value: this.lowerExpr(n.value) };
            }
            case 'MethodCall': {
                // a[i] = v → operator_set[] が ExprStmt として現れる
                if (n.method === 'operator_set[]') {
                    return {
                        type: 'GpuAssign',
                        target: {
                            type: 'GpuIndex',
                            base: this.lowerExpr(n.receiver),
                            index: this.lowerExpr(n.args[0]),
                        },
                        value: this.lowerExpr(n.args[1]),
                    };
                }
                // それ以外のメソッド呼び出しは ExprStmt として
                return { type: 'GpuExprStmt', expr: this.lowerExpr(n) };
            }
            case 'Intrinsic': {
                // 副作用組み込み (barrier / atomicStore 等) は ExprStmt として扱う
                return { type: 'GpuExprStmt', expr: this.lowerExpr(n) };
            }
            case 'IfStmt': {
                // checker が `if (cond)` を __builtin_if(cond) でラップしている
                const rawCond = (n.cond.type === 'Intrinsic' && n.cond.name === '__builtin_if')
                    ? n.cond.args[0] : n.cond;
                const out: any = {
                    type: 'GpuIf',
                    cond: this.lowerExpr(rawCond),
                    then: n.body.map(s => this.lowerStmt(s)).filter(x => x !== null),
                };
                if (n.else) {
                    if (n.else.type === 'IfStmt') {
                        out.else = [this.lowerStmt(n.else)];
                    } else {
                        out.else = n.else.body.map(s => this.lowerStmt(s)).filter(x => x !== null);
                    }
                }
                return out;
            }
            case 'WhileStmt': {
                const rawCond = (n.cond.type === 'Intrinsic' && n.cond.name === '__builtin_while')
                    ? n.cond.args[0] : n.cond;
                return {
                    type: 'GpuWhile',
                    cond: this.lowerExpr(rawCond),
                    body: n.body.map(s => this.lowerStmt(s)).filter(x => x !== null),
                };
            }
            case 'ForStmt': {
                const rawCond = (n.cond.type === 'Intrinsic' && n.cond.name === '__builtin_if')
                    ? n.cond.args[0] : n.cond;
                return {
                    type: 'GpuFor',
                    init: this.lowerStmt(n.init),
                    cond: this.lowerExpr(rawCond),
                    update: this.lowerStmt(n.update),
                    body: n.body.map(s => this.lowerStmt(s)).filter(x => x !== null),
                };
            }
            case 'ReturnStmt':
                return { type: 'GpuReturn' };
            case 'BreakStmt':
                return { type: 'GpuBreak' };
            case 'BlockStmt': {
                // GPU IR にブロック構文はないので flatten
                const out: any[] = [];
                for (const s of n.body) {
                    const lowered = this.lowerStmt(s);
                    if (lowered !== null) out.push(lowered);
                }
                return out.length === 1 ? out[0] : { type: 'GpuIf', cond: { type: 'GpuLiteral', valueType: 'bool', value: true }, then: out };
            }
        }
        return null;
    }
}

export function lowerKernel(fn: IR.FunctionDecl): GpuKernelIR {
    // FunctionDecl name は "__gpu_kernel_<actualName>"
    const actualName = fn.name.startsWith('__gpu_kernel_') ? fn.name.slice('__gpu_kernel_'.length) : fn.name;
    const l = new Lower(actualName);
    const body = fn.body.map(s => l.lowerStmt(s)).filter(x => x !== null);
    const params = fn.params.map((p, i) => ({
        name: p.name, type: mapType(p.resolvedType), binding: i,
    }));
    return {
        name: actualName,
        workgroupSize: fn.workgroupSize ?? [64, 1, 1],
        params,
        locals: l.locals,
        body,
    };
}

// IR ノード列から isGpu な FunctionDecl をすべて拾って GPU IR モジュールを構築
export function lowerModule(nodes: IR.ASTNode[]): GpuModule | null {
    const kernels: GpuKernelIR[] = [];
    for (const n of nodes) {
        if (n.type === 'FunctionDecl' && n.isGpu) {
            kernels.push(lowerKernel(n));
        }
    }
    if (kernels.length === 0) return null;
    return { mozaicScriptGpu: '1.0', kernels };
}
