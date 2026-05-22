// compiler/optimizer.ts — IR レベル最適化パス
//
// primitive wrapper クラス（単一 private bits: _mXX フィールドを持つクラス）の
// メソッド呼び出しをインライン展開する。
//
// 変換例（i32 の場合）:
//   MethodCall { operator+, recv=X, args=[Y] }
//   → NewExpr { i32, [Intrinsic { __builtin_i32_add, [X.bits, Y.bits] }] }
//
// さらに (new i32(x)).bits → x まで畳み込むため、連鎖的にインライン展開する。

import * as IR from '../interpreter/types';
import type { Registry } from './checker';

const MACHINE_TYPES = new Set(['_m8','_m16','_m32','_m64','_m128','_m256','_m512']);

export class Optimizer {
    // className → bitsType (_m32 等)
    private wrappers: Map<string, string> = new Map();

    constructor(private registry: Registry) {
        this.detectWrappers();
    }

    // primitive wrapper クラスを検出する
    private detectWrappers(): void {
        for (const [name, cls] of this.registry.classEnv) {
            const priv = cls.members.filter(f => f.access === 'private');
            if (priv.length === 1 && priv[0].name === 'bits' && MACHINE_TYPES.has(priv[0].resolvedType)) {
                this.wrappers.set(name, priv[0].resolvedType);
            }
        }
    }

    optimize(nodes: IR.ASTNode[]): IR.ASTNode[] {
        return nodes.map(n => this.optNode(n));
    }

    // ── ノード最適化（bottom-up） ─────────────────────────────────────────────

    private optNode(node: IR.ASTNode): IR.ASTNode {
        // 子を先に最適化してから自身を変換する（bottom-up）
        const n = this.optChildren(node);

        if (n.type === 'MethodCall') {
            const inlined = this.tryInline(n as IR.MethodCall);
            if (inlined !== n) return this.optNode(inlined); // 再帰して連鎖展開
        }

        // (new Wrapper(x)).bits → x
        if (n.type === 'MemberAccess' && (n as IR.MemberAccess).member === 'bits') {
            const ma = n as IR.MemberAccess;
            if (ma.receiver.type === 'NewExpr') {
                const ne = ma.receiver as IR.NewExpr;
                const base = ne.resolvedType.split('<')[0];
                if (this.wrappers.has(base) && !ne.elements && ne.args.length === 1) {
                    return ne.args[0];
                }
            }
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
            // Thread ノード
            case 'ThreadSpawn': {
                const n = node as IR.ThreadSpawn;
                return { ...n, args: n.args.map(a => this.optNode(a)) };
            }
            case 'ThreadJoin': {
                const n = node as IR.ThreadJoin;
                return { ...n, threadId: this.optNode(n.threadId) };
            }
            case 'ThreadPoolCreate': {
                const n = node as IR.ThreadPoolCreate;
                return { ...n, size: this.optNode(n.size) };
            }
            case 'ThreadPoolSubmit': {
                const n = node as IR.ThreadPoolSubmit;
                return { ...n, pool: this.optNode(n.pool), args: n.args.map(a => this.optNode(a)) };
            }
            case 'ThreadPoolWait': {
                const n = node as IR.ThreadPoolWait;
                return { ...n, pool: this.optNode(n.pool) };
            }
            case 'ThreadPoolDestroy': {
                const n = node as IR.ThreadPoolDestroy;
                return { ...n, pool: this.optNode(n.pool) };
            }
            case 'MutexLock': {
                const n = node as IR.MutexLock;
                return { ...n, mutexId: this.optNode(n.mutexId) };
            }
            case 'MutexUnlock': {
                const n = node as IR.MutexUnlock;
                return { ...n, mutexId: this.optNode(n.mutexId) };
            }
            case 'CondVarWait': {
                const n = node as IR.CondVarWait;
                return { ...n, condVar: this.optNode(n.condVar), mutexId: this.optNode(n.mutexId) };
            }
            case 'CondVarSignal': {
                const n = node as IR.CondVarSignal;
                return { ...n, condVar: this.optNode(n.condVar) };
            }
            case 'CondVarBroadcast': {
                const n = node as IR.CondVarBroadcast;
                return { ...n, condVar: this.optNode(n.condVar) };
            }
            case 'AtomicLoad': {
                const n = node as IR.AtomicLoad;
                return { ...n, ptr: this.optNode(n.ptr) };
            }
            case 'AtomicStore': {
                const n = node as IR.AtomicStore;
                return { ...n, ptr: this.optNode(n.ptr), value: this.optNode(n.value) };
            }
            case 'AtomicCas': {
                const n = node as IR.AtomicCas;
                return { ...n, ptr: this.optNode(n.ptr), expected: this.optNode(n.expected), desired: this.optNode(n.desired) };
            }
            case 'AtomicFetchAdd': {
                const n = node as IR.AtomicFetchAdd;
                return { ...n, ptr: this.optNode(n.ptr), value: this.optNode(n.value) };
            }
            case 'AtomicFetchSub': {
                const n = node as IR.AtomicFetchSub;
                return { ...n, ptr: this.optNode(n.ptr), value: this.optNode(n.value) };
            }
            default:
                return node;
        }
    }

    private optFn(fn: IR.FunctionDecl): IR.FunctionDecl {
        return { ...fn, body: fn.body.map(n => this.optNode(n)) };
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
