// compiler/optimizer.ts — IR レベル最適化パス
//
// 最適化レベル:
//   O0 — 最適化なし（恒等変換）
//   O1 — メソッドインライン展開 + (new W(x)).field → x 畳み込み
//   O2 — O1 + Intrinsic 引数ラッパー除去 + 定数畳み込み + 代数的恒等式（デフォルト）
//
// primitive wrapper クラス（単一 private _mXX フィールドを持つクラス）の
// メソッド呼び出しをインライン展開する。フィールド名はハードコードせず
// registry から動的に取得するため、コアライブラリの実装変更に追従する。

import * as IR from '../interpreter/types';
import type { Registry } from './checker';

export type OptLevel = 0 | 1 | 2;

const MACHINE_TYPES = new Set(['_m8','_m16','_m32','_m64','_m128','_m256','_m512']);

interface WrapperInfo {
    fieldName: string;   // 実際のフィールド名（"bits" とは限らない）
    bitsType:  string;   // _m32 / _m64 等
}

export class Optimizer {
    // className → WrapperInfo
    private wrappers: Map<string, WrapperInfo> = new Map();

    constructor(private registry: Registry, private level: OptLevel = 2) {
        this.detectWrappers();
    }

    // primitive wrapper クラスを検出する
    // 「private _mXX フィールドが 1 つだけ」という構造的条件のみ使用し、
    // フィールド名（"bits" 等）はハードコードしない。
    private detectWrappers(): void {
        for (const [name, cls] of this.registry.classEnv) {
            const priv = cls.members.filter(f => f.access === 'private');
            if (priv.length === 1 && MACHINE_TYPES.has(priv[0].resolvedType)) {
                this.wrappers.set(name, { fieldName: priv[0].name, bitsType: priv[0].resolvedType });
            }
        }
    }

    optimize(nodes: IR.ASTNode[]): IR.ASTNode[] {
        if (this.level === 0) return nodes; // -O0: 恒等変換
        return nodes.map(n => this.optNode(n));
    }

    // ── ノード最適化（bottom-up） ─────────────────────────────────────────────

    private optNode(node: IR.ASTNode): IR.ASTNode {
        // 子を先に最適化してから自身を変換する（bottom-up）
        const n = this.optChildren(node);

        // O1+: primitive wrapper メソッドのインライン展開
        if (n.type === 'MethodCall') {
            const inlined = this.tryInline(n as IR.MethodCall);
            if (inlined !== n) return this.optNode(inlined); // 再帰して連鎖展開
        }

        // O1+: (new Wrapper(x)).<field> → x （フィールド名は registry から取得）
        if (n.type === 'MemberAccess') {
            const ma = n as IR.MemberAccess;
            if (ma.receiver.type === 'NewExpr') {
                const ne = ma.receiver as IR.NewExpr;
                const base = ne.resolvedType.split('<')[0];
                const info = this.wrappers.get(base);
                if (info && ma.member === info.fieldName && !ne.elements && ne.args.length === 1) {
                    return ne.args[0];
                }
            }
        }

        // O2+: Intrinsic 引数ラッパー除去 + 定数畳み込み + 代数的恒等式
        if (n.type === 'Intrinsic' && this.level >= 2) {
            const result = this.optIntrinsic(n as IR.Intrinsic);
            if (result !== n) return result;
        }

        return n;
    }

    // ── 子ノードを再帰的に最適化 ──────────────────────────────────────────────

    private optChildren(node: IR.ASTNode): IR.ASTNode {
        switch (node.type) {
            case 'VarDecl': {
                const n = node as IR.VarDecl;
                return { ...n, value: this.optNode(n.value) };
            }
            case 'Assign': {
                const n = node as IR.Assign;
                return { ...n, target: this.optNode(n.target), value: this.optNode(n.value) };
            }
            case 'MethodCall': {
                const n = node as IR.MethodCall;
                return { ...n, receiver: this.optNode(n.receiver), args: n.args.map(a => this.optNode(a)) };
            }
            case 'NewExpr': {
                const n = node as IR.NewExpr;
                if (n.elements) return n; // 文字列リテラルはスキップ
                return { ...n, args: n.args.map(a => this.optNode(a)) };
            }
            case 'MemberAccess': {
                const n = node as IR.MemberAccess;
                return { ...n, receiver: this.optNode(n.receiver) };
            }
            case 'Intrinsic': {
                const n = node as IR.Intrinsic;
                return { ...n, args: n.args.map(a => this.optNode(a)) };
            }
            case 'IfStmt': {
                const n = node as IR.IfStmt;
                return {
                    ...n,
                    cond: this.optNode(n.cond),
                    body: n.body.map(c => this.optNode(c)),
                    else: n.else ? (this.optNode(n.else as IR.ASTNode) as IR.IfStmt | IR.ElseStmt) : null,
                };
            }
            case 'ElseStmt': {
                const n = node as IR.ElseStmt;
                return { ...n, body: n.body.map(c => this.optNode(c)) };
            }
            case 'WhileStmt': {
                const n = node as IR.WhileStmt;
                return { ...n, cond: this.optNode(n.cond), body: n.body.map(c => this.optNode(c)) };
            }
            case 'ForStmt': {
                const n = node as IR.ForStmt;
                return {
                    ...n,
                    init:   this.optNode(n.init),
                    cond:   this.optNode(n.cond),
                    update: this.optNode(n.update),
                    body:   n.body.map(c => this.optNode(c)),
                };
            }
            case 'ReturnStmt': {
                const n = node as IR.ReturnStmt;
                return n.value ? { ...n, value: this.optNode(n.value) } : n;
            }
            case 'ClassDecl': {
                const n = node as IR.ClassDecl;
                return { ...n, methods: n.methods.map(m => this.optFn(m)) };
            }
            case 'FunctionDecl': {
                return this.optFn(node as IR.FunctionDecl);
            }
            default:
                return node;
        }
    }

    private optFn(fn: IR.FunctionDecl): IR.FunctionDecl {
        return { ...fn, body: fn.body.map(n => this.optNode(n)) };
    }

    // ── Intrinsic 最適化 ──────────────────────────────────────────────────────

    private optIntrinsic(intr: IR.Intrinsic): IR.ASTNode {
        // 1. primitive wrapper を引数から剥がす: NewExpr{Wrapper,[x]} → x
        let changed = false;
        const unwrapped = intr.args.map(arg => {
            if (arg.type === 'NewExpr') {
                const ne = arg as IR.NewExpr;
                const base = ne.resolvedType.split('<')[0];
                if (this.wrappers.has(base) && !ne.elements && ne.args.length === 1) {
                    changed = true;
                    return ne.args[0];
                }
            }
            return arg;
        });
        const intr2: IR.Intrinsic = changed ? { ...intr, args: unwrapped } : intr;

        // 2. 代数的恒等式（片側がリテラルのとき）
        const simp = this.tryAlgebraic(intr2);
        if (simp !== intr2) return simp;

        // 3. 定数畳み込み（両辺がリテラルのとき）
        return this.tryConstFold(intr2);
    }

    // 代数的恒等式: x+0→x, x*1→x, x*0→0, x-0→x, x/1→x
    private tryAlgebraic(intr: IR.Intrinsic): IR.ASTNode {
        if (intr.args.length !== 2) return intr;
        const [a, b] = intr.args;
        const aLit = a.type === 'RawLiteral' ? (a as IR.RawLiteral).value : null;
        const bLit = b.type === 'RawLiteral' ? (b as IR.RawLiteral).value : null;

        const isAdd  = /^__builtin_(i32|u32|i64|u64|f32|f64)_add$/.test(intr.name);
        const isSub  = /^__builtin_(i32|u32|i64|u64|f32|f64)_sub$/.test(intr.name);
        const isMul  = /^__builtin_(i32|u32|i64|u64|f32|f64)_mul$/.test(intr.name);
        const isDiv  = /^__builtin_(i32|u32|i64|u64|f32|f64)_div$/.test(intr.name);

        if (isAdd) {
            if (bLit === 0) return a;
            if (aLit === 0) return b;
        }
        if (isSub && bLit === 0) return a;
        if (isMul) {
            if (bLit === 1) return a;
            if (aLit === 1) return b;
            if (bLit === 0) return b; // 0 (RawLiteral)
            if (aLit === 0) return a;
        }
        if (isDiv && bLit === 1) return a;

        return intr;
    }

    // 定数畳み込み: 両引数が RawLiteral のとき compile-time に計算
    private tryConstFold(intr: IR.Intrinsic): IR.ASTNode {
        const allLit = intr.args.every(a => a.type === 'RawLiteral');
        if (!allLit) return intr;
        const vals = intr.args.map(a => (a as IR.RawLiteral).value);
        const result = this.evalBuiltin(intr.name, vals);
        if (result === null) return intr;
        return { type: 'RawLiteral', kind: 'int', value: result };
    }

    private evalBuiltin(name: string, [a, b]: number[]): number | null {
        switch (name) {
            // i32
            case '__builtin_i32_add': return (a + b) | 0;
            case '__builtin_i32_sub': return (a - b) | 0;
            case '__builtin_i32_mul': return Math.imul(a, b);
            case '__builtin_i32_div': return b === 0 ? null : (Math.trunc(a / b)) | 0;
            case '__builtin_i32_mod': return b === 0 ? null : (a - Math.trunc(a / b) * b) | 0;
            case '__builtin_i32_neg': return (-a) | 0;
            case '__builtin_i32_eq':  return a === b ? 1 : 0;
            case '__builtin_i32_lt':  return a < b ? 1 : 0;
            case '__builtin_i32_gt':  return a > b ? 1 : 0;
            case '__builtin_i32_or':  return (a | b) === 0 ? 0 : 1;
            case '__builtin_i32_and': return (a !== 0 && b !== 0) ? 1 : 0;
            case '__builtin_i32_not': return a !== 0 ? 0 : 1;
            case '__builtin_i32_shl': return (a << (b & 31)) | 0;
            case '__builtin_i32_shr': return (a >> (b & 31)) | 0;
            case '__builtin_i32_bitwise_and': return (a & b) | 0;
            case '__builtin_i32_bitwise_or':  return (a | b) | 0;
            case '__builtin_i32_bitwise_xor': return (a ^ b) | 0;
            case '__builtin_i32_rotl': { const s = (b & 31); return ((a << s) | (a >>> (32 - s))) | 0; }
            case '__builtin_i32_rotr': { const s = (b & 31); return ((a >>> s) | (a << (32 - s))) | 0; }
            case '__builtin_i32_clz':  return Math.clz32(a);
            case '__builtin_i32_popcnt': {
                let n = a >>> 0, c = 0;
                while (n) { c += n & 1; n >>>= 1; }
                return c;
            }
            // u32
            case '__builtin_u32_add': return ((a >>> 0) + (b >>> 0)) >>> 0;
            case '__builtin_u32_sub': return ((a >>> 0) - (b >>> 0)) >>> 0;
            case '__builtin_u32_mul': return Math.imul(a, b) >>> 0;
            case '__builtin_u32_div': return b === 0 ? null : ((a >>> 0) / (b >>> 0)) >>> 0;
            case '__builtin_u32_mod': return b === 0 ? null : ((a >>> 0) % (b >>> 0)) >>> 0;
            case '__builtin_u32_eq':  return (a >>> 0) === (b >>> 0) ? 1 : 0;
            case '__builtin_u32_lt':  return (a >>> 0) < (b >>> 0) ? 1 : 0;
            case '__builtin_u32_gt':  return (a >>> 0) > (b >>> 0) ? 1 : 0;
            case '__builtin_u32_shl': return ((a >>> 0) << (b & 31)) >>> 0;
            case '__builtin_u32_shr': return ((a >>> 0) >>> (b & 31)) >>> 0;
            // f32
            case '__builtin_f32_add': return Math.fround(a + b);
            case '__builtin_f32_sub': return Math.fround(a - b);
            case '__builtin_f32_mul': return Math.fround(a * b);
            case '__builtin_f32_div': return b === 0 ? null : Math.fround(a / b);
            case '__builtin_f32_neg': return Math.fround(-a);
            case '__builtin_f32_eq':  return a === b ? 1 : 0;
            case '__builtin_f32_lt':  return a < b ? 1 : 0;
            case '__builtin_f32_gt':  return a > b ? 1 : 0;
            case '__builtin_f32_abs': return Math.fround(Math.abs(a));
            case '__builtin_f32_sqrt': return Math.fround(Math.sqrt(a));
            case '__builtin_f32_floor': return Math.fround(Math.floor(a));
            case '__builtin_f32_ceil':  return Math.fround(Math.ceil(a));
            case '__builtin_f32_trunc': return Math.fround(Math.trunc(a));
            case '__builtin_f32_min':   return Math.fround(Math.min(a, b));
            case '__builtin_f32_max':   return Math.fround(Math.max(a, b));
            // 型変換
            case '__builtin_i32_to_f32': return Math.fround(a);
            case '__builtin_f32_to_i32': return Math.trunc(a) | 0;
            case '__builtin_i32_to_u32': return a >>> 0;
            case '__builtin_u32_to_i32': return a | 0;
            case '__builtin_u32_to_f32': return Math.fround(a >>> 0);
            case '__builtin_f32_to_u32': return (Math.trunc(a)) >>> 0;
            default: return null;
        }
    }

    // ── メソッドインライン展開 ─────────────────────────────────────────────────

    private tryInline(call: IR.MethodCall): IR.ASTNode {
        const recvType = this.getType(call.receiver);
        const base = recvType.split('<')[0];

        if (!this.wrappers.has(base)) return call;

        const cls = this.registry.classEnv.get(base);
        if (!cls) return call;

        const method = cls.methods.find(m => m.name === call.method);
        if (!method) return call;

        // 単一 return 文のみインライン対象（コンストラクタ等は除く）
        if (method.body.length !== 1 || method.body[0].type !== 'ReturnStmt') return call;
        const ret = method.body[0] as IR.ReturnStmt;
        if (!ret.value) return call;

        // this → receiver、各パラメータ → 引数で置換
        const map = new Map<string, IR.ASTNode>();
        map.set('this', call.receiver);
        method.params.forEach((p, i) => { if (call.args[i]) map.set(p.name, call.args[i]); });

        return this.subst(ret.value, map);
    }

    // ── 識別子置換（非破壊的） ────────────────────────────────────────────────

    private subst(node: IR.ASTNode, map: Map<string, IR.ASTNode>): IR.ASTNode {
        if (node.type === 'Identifier') {
            return map.get((node as IR.Identifier).name) ?? node;
        }
        return this.substChildren(node, map);
    }

    private substChildren(node: IR.ASTNode, map: Map<string, IR.ASTNode>): IR.ASTNode {
        switch (node.type) {
            case 'MethodCall': {
                const n = node as IR.MethodCall;
                return { ...n, receiver: this.subst(n.receiver, map), args: n.args.map(a => this.subst(a, map)) };
            }
            case 'NewExpr': {
                const n = node as IR.NewExpr;
                if (n.elements) return n;
                return { ...n, args: n.args.map(a => this.subst(a, map)) };
            }
            case 'MemberAccess': {
                const n = node as IR.MemberAccess;
                return { ...n, receiver: this.subst(n.receiver, map) };
            }
            case 'Intrinsic': {
                const n = node as IR.Intrinsic;
                return { ...n, args: n.args.map(a => this.subst(a, map)) };
            }
            default:
                return node;
        }
    }

    // ── 型の取得 ──────────────────────────────────────────────────────────────

    private getType(node: IR.ASTNode): string {
        switch (node.type) {
            case 'Identifier':   return (node as IR.Identifier).resolvedType;
            case 'MethodCall':   return (node as IR.MethodCall).resolvedType;
            case 'NewExpr':      return (node as IR.NewExpr).resolvedType;
            case 'Intrinsic':    return (node as IR.Intrinsic).resolvedType;
            case 'MemberAccess': return (node as IR.MemberAccess).resolvedType;
            case 'RawLiteral':   return '_m32';
            default:             return 'void';
        }
    }
}
