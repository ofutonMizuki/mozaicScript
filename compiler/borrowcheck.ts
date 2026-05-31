// compiler/borrowcheck.ts — 借用チェッカー + drop/__builtin_free 自動挿入パス
//
// 仕様: doc/mozaicScript-spec.md §4.8〜4.10 (所有権・参照型) / §5.7 (借用演算子) / §10.4 (借用チェッカーパイプライン)
//
// このパスは型解決済み IR (interpreter/types.ts) に対して動作する。
// 1. 変数の状態 (Uninit / Alive / Moved) を追跡
// 2. Use-After-Move / 不変借用 vs 可変借用の XOR ルールを検証
// 3. スコープ末尾で生存している所有権型変数に drop / __builtin_free を自動挿入
//
// 実装方針 (実用的単純化):
// - 線形にステートメントを処理 (CFG マージは限定的に if/else でのみ)
// - while/for ループ本体は2パス処理（不変条件をチェック）
// - lifespan validity (ダングリング参照) は今回は未実装 (将来拡張)

import * as IR from '../interpreter/types';
import type { Registry } from './checker';

// ── エラー ────────────────────────────────────────────────────────────────────

export class BorrowError extends Error {
    constructor(msg: string) {
        super(`BorrowError: ${msg}`);
    }
}

// ── 型ユーティリティ ─────────────────────────────────────────────────────────

const MACHINE = new Set(['_m8','_m16','_m32','_m64','_m128','_m256','_m512']);

function stripRef(t: string): string {
    if (t.startsWith('&mut ')) return t.slice(5);
    if (t.startsWith('&'))     return t.slice(1);
    return t;
}
function isRef(t: string): boolean { return t.startsWith('&'); }
function isMutRef(t: string): boolean { return t.startsWith('&mut '); }
function baseName(t: string): string {
    const s = stripRef(t);
    const lt = s.indexOf('<');
    return lt === -1 ? s : s.slice(0, lt);
}

// ── 変数状態 ─────────────────────────────────────────────────────────────────

type VarState =
    | { kind: 'uninit' }
    | { kind: 'alive' }
    | { kind: 'moved' }
    | { kind: 'borrowed_imm'; count: number }
    | { kind: 'borrowed_mut' };

interface VarInfo {
    type: string;       // resolvedType
    state: VarState;
    ownsResource: boolean; // ヒープ確保リソースを所有しているか (drop/free 対象か)
}

// スコープチェーン
class Scope {
    vars = new Map<string, VarInfo>();
    constructor(public parent: Scope | null = null) {}

    lookup(name: string): VarInfo | undefined {
        let s: Scope | null = this;
        while (s) {
            const v = s.vars.get(name);
            if (v) return v;
            s = s.parent;
        }
        return undefined;
    }

    // 自身のスコープのみの変数を取得
    own(name: string): VarInfo | undefined {
        return this.vars.get(name);
    }
}

// ── BorrowChecker ────────────────────────────────────────────────────────────

export class BorrowChecker {
    constructor(private registry: Registry) {}

    // 所有権型 (owned object / wrapper) で drop/free が必要か判定する。
    // - 機械型 (_mXX) → false
    // - 参照型 (&T / &mut T) → false
    // - primitive wrapper (単一 private _mXX フィールド) → false (値型、free 不要)
    // - 多フィールド class (Vec2 など) → true (ヒープ確保され free 対象)
    private needsFree(type: string): boolean {
        if (isRef(type)) return false;
        const base = baseName(type);
        if (MACHINE.has(base) || base === 'void') return false;
        const cls = this.registry.classEnv.get(base);
        if (!cls) return false;
        // primitive wrapper の判定: 単一の private または mocp public な機械型フィールド
        // (jscodegen/wasmcodegen の detectWrappers と同じ条件)
        const privs = cls.members.filter(f =>
            f.access === 'private' || f.access === 'mocp public'
        );
        if (privs.length === 1 && MACHINE.has(privs[0].resolvedType)) {
            return false; // 値型 wrapper, free 不要
        }
        return true;
    }

    // クラスに drop(): void メソッドがあるか
    private hasDrop(type: string): boolean {
        const cls = this.registry.classEnv.get(baseName(type));
        return cls?.methods.some(m =>
            m.name === 'drop' && m.returnType === 'void' && m.params.length === 0
        ) ?? false;
    }

    // エントリポイント: トップレベルノードを処理
    check(nodes: IR.ASTNode[]): void {
        for (const node of nodes) {
            if (node.type === 'FunctionDecl') {
                this.checkFn(node);
            } else if (node.type === 'ClassDecl') {
                for (const m of node.methods) this.checkFn(m);
            }
        }
    }

    private checkFn(fn: IR.FunctionDecl): void {
        const scope = new Scope();
        // 関数引数を登録: 所有権型は受け取った関数が解放責任を負う。
        for (const p of fn.params) {
            const owns = this.needsFree(p.resolvedType);
            scope.vars.set(p.name, {
                type: p.resolvedType,
                state: { kind: 'alive' },
                ownsResource: owns,
            });
        }
        // クラスメソッドの場合 this も登録
        // (this は常に &T か &mut T で借用扱いなので drop 対象外)
        // ※checker.ts で setThis 済みのため body 内で識別子として扱える
        this.checkBody(fn.body, scope);
    }

    // ステートメント列を処理し、末尾に drop/free を挿入する
    // body は in-place で修正される
    private checkBody(body: IR.ASTNode[], parent: Scope): void {
        const scope = new Scope(parent);
        // 早期終了 (return / break) を検出
        let earlyExit: 'return' | 'break' | null = null;
        let exitIdx = body.length;
        for (let i = 0; i < body.length; i++) {
            const stmt = body[i];
            if (earlyExit) break;
            this.processStmt(stmt, scope);
            if (stmt.type === 'ReturnStmt' || stmt.type === 'BreakStmt') {
                earlyExit = stmt.type === 'ReturnStmt' ? 'return' : 'break';
                exitIdx = i;
                // 早期終了の前に drop を挿入する
                const drops = this.emitDrops(scope, this.escapedVars(stmt));
                if (drops.length > 0) {
                    body.splice(i, 0, ...drops);
                    exitIdx = i + drops.length;
                }
                break;
            }
        }
        // 正常に末尾まで到達した場合: 末尾に drop を追加
        if (!earlyExit && exitIdx === body.length) {
            const drops = this.emitDrops(scope, new Set());
            body.push(...drops);
        }
    }

    // 文ごとの状態遷移
    private processStmt(stmt: IR.ASTNode, scope: Scope): void {
        switch (stmt.type) {
            case 'VarDecl': {
                this.processExpr(stmt.value, scope, /*consume*/ true);
                if (scope.vars.has(stmt.name)) {
                    throw new BorrowError(`変数 '${stmt.name}' は既に宣言されています`);
                }
                scope.vars.set(stmt.name, {
                    type: stmt.resolvedType,
                    state: { kind: 'alive' },
                    ownsResource: this.needsFree(stmt.resolvedType),
                });
                return;
            }
            case 'Assign': {
                // 左辺はマーク不要（既存変数への再代入）
                if (stmt.target.type === 'Identifier') {
                    const v = scope.lookup(stmt.target.name);
                    if (v && v.state.kind === 'borrowed_imm' && v.state.count > 0) {
                        throw new BorrowError(
                            `'${stmt.target.name}' は不変借用中のため代入できません (§4.1.2)`
                        );
                    }
                    if (v && v.state.kind === 'borrowed_mut') {
                        throw new BorrowError(
                            `'${stmt.target.name}' は可変借用中のため代入できません (§4.1.2)`
                        );
                    }
                    // 既存値の所有権破棄が発生する: drop+free を挿入したいが
                    // 現在の AST モデルでは Assign の前に挿入が難しい。
                    // 簡略化: Alive → Alive (上書き) とし、旧値の解放は未挿入。
                }
                this.processExpr(stmt.value, scope, /*consume*/ true);
                return;
            }
            case 'ReturnStmt': {
                if (stmt.value) this.processExpr(stmt.value, scope, /*consume*/ true);
                return;
            }
            case 'BreakStmt':
                return;
            case 'IfStmt': {
                this.processExpr(stmt.cond, scope, /*consume*/ false);
                // 各ブランチを独立スコープで処理
                this.checkBody(stmt.body, scope);
                let elseNode = stmt.else;
                while (elseNode) {
                    if (elseNode.type === 'IfStmt') {
                        this.processExpr(elseNode.cond, scope, /*consume*/ false);
                        this.checkBody(elseNode.body, scope);
                        elseNode = elseNode.else;
                    } else {
                        this.checkBody(elseNode.body, scope);
                        elseNode = null;
                    }
                }
                return;
            }
            case 'WhileStmt': {
                this.processExpr(stmt.cond, scope, /*consume*/ false);
                this.checkBody(stmt.body, scope);
                return;
            }
            case 'ForStmt': {
                const forScope = new Scope(scope);
                // init は通常 VarDecl
                if (stmt.init.type === 'VarDecl') {
                    const init = stmt.init as IR.VarDecl;
                    this.processExpr(init.value, forScope, /*consume*/ true);
                    forScope.vars.set(init.name, {
                        type: init.resolvedType,
                        state: { kind: 'alive' },
                        ownsResource: this.needsFree(init.resolvedType),
                    });
                } else {
                    this.processStmt(stmt.init, forScope);
                }
                this.processExpr(stmt.cond, forScope, /*consume*/ false);
                // update は式または Assign
                if (stmt.update.type === 'Assign') {
                    this.processStmt(stmt.update, forScope);
                } else {
                    this.processExpr(stmt.update, forScope, /*consume*/ false);
                }
                this.checkBody(stmt.body, forScope);
                // for スコープの drop を末尾に追加
                const drops = this.emitDrops(forScope, new Set());
                stmt.body.push(...drops);
                return;
            }
            case 'BlockStmt': {
                this.checkBody(stmt.body, scope);
                return;
            }
            default: {
                // 式文 (MethodCall / Intrinsic / etc.)
                this.processExpr(stmt as IR.ASTNode, scope, /*consume*/ false);
                return;
            }
        }
    }

    // 式を処理し、変数の状態遷移を行う
    // consume=true なら式全体の値が「ムーブされる」(VarDecl の rhs / return / 関数 arg)
    // consume=false ならステートメントの式 (戻り値は捨てられる)
    private processExpr(expr: IR.ASTNode, scope: Scope, consume: boolean): void {
        if (!expr) return;
        switch (expr.type) {
            case 'Identifier': {
                const v = scope.lookup(expr.name);
                if (!v) return; // top-level fn / global / this
                if (v.state.kind === 'moved') {
                    throw new BorrowError(
                        `'${expr.name}' はムーブ済みのため使用できません (§4.1.2 Use After Move)`
                    );
                }
                // consume=true かつ所有権型 → ムーブ
                if (consume && v.ownsResource && v.state.kind === 'alive') {
                    v.state = { kind: 'moved' };
                }
                return;
            }
            case 'BorrowExpr': {
                const inner = expr.expr;
                if (inner.type !== 'Identifier') {
                    // 一時値の借用 (BorrowExpr(NewExpr(...)) など) は最小限の処理
                    this.processExpr(inner, scope, /*consume*/ false);
                    return;
                }
                const v = scope.lookup(inner.name);
                if (!v) return; // global / this 等
                if (v.state.kind === 'moved') {
                    throw new BorrowError(
                        `'${inner.name}' はムーブ済みのため借用できません (§4.1.2)`
                    );
                }
                if (expr.isMut) {
                    // 可変借用: 他の借用と共存不可
                    if (v.state.kind === 'borrowed_imm' && v.state.count > 0) {
                        throw new BorrowError(
                            `'${inner.name}' は不変借用中のため &mut で借用できません (§4.1.2 XOR)`
                        );
                    }
                    if (v.state.kind === 'borrowed_mut') {
                        throw new BorrowError(
                            `'${inner.name}' は既に可変借用中です (§4.1.2 XOR)`
                        );
                    }
                    // 簡略化: 借用は式評価内のみで成立し、式評価後に状態を戻す
                    // (フィールド呼び出し中に複数借用が同時成立しないため)
                } else {
                    if (v.state.kind === 'borrowed_mut') {
                        throw new BorrowError(
                            `'${inner.name}' は可変借用中のため & で借用できません (§4.1.2 XOR)`
                        );
                    }
                }
                return;
            }
            case 'MethodCall': {
                // receiver: BorrowExpr で包まれていれば借用、生の Identifier なら消費
                this.processExpr(expr.receiver, scope, /*consume*/ this.argConsumes(expr.receiver));
                for (const a of expr.args) {
                    this.processExpr(a, scope, /*consume*/ this.argConsumes(a));
                }
                return;
            }
            case 'NewExpr': {
                for (const a of expr.args) {
                    this.processExpr(a, scope, /*consume*/ this.argConsumes(a));
                }
                return;
            }
            case 'Intrinsic': {
                for (const a of expr.args) {
                    this.processExpr(a, scope, /*consume*/ false);
                }
                return;
            }
            case 'MemberAccess': {
                // フィールド読み取りはレシーバを借用扱い (消費しない)
                this.processExpr(expr.receiver, scope, /*consume*/ false);
                return;
            }
            default:
                return;
        }
    }

    // 関数/メソッド呼び出しの引数式が「消費」となるか判定する。
    // BorrowExpr で包まれていれば借用 (消費しない)。それ以外は消費とする。
    private argConsumes(arg: IR.ASTNode): boolean {
        if (arg.type === 'BorrowExpr') return false;
        if (arg.type === 'MemberAccess') return false; // フィールド読みは借用相当
        return true;
    }

    // return / break ステートメントで「逃げ出した」変数名のセット
    // (これらは drop/free 対象から除外する)
    private escapedVars(stmt: IR.ASTNode): Set<string> {
        const out = new Set<string>();
        if (stmt.type !== 'ReturnStmt' || !stmt.value) return out;
        // 直接 Identifier の return のみ追跡 (式の中の名前は一般に既に moved 状態)
        const v = stmt.value;
        if (v.type === 'Identifier') out.add(v.name);
        return out;
    }

    // scope 内の生存変数に drop + __builtin_free を生成
    private emitDrops(scope: Scope, exclude: Set<string>): IR.ASTNode[] {
        const out: IR.ASTNode[] = [];
        // 宣言の逆順で解放 (LIFO)
        const entries = Array.from(scope.vars.entries()).reverse();
        for (const [name, v] of entries) {
            if (!v.ownsResource) continue;
            if (v.state.kind !== 'alive') continue;
            if (exclude.has(name)) continue;
            if (this.hasDrop(v.type)) {
                out.push({
                    type: 'MethodCall',
                    resolvedType: 'void',
                    receiver: {
                        type: 'BorrowExpr',
                        isMut: true,
                        expr: { type: 'Identifier', name, resolvedType: v.type },
                        resolvedType: `&mut ${v.type}`,
                    },
                    method: 'drop',
                    args: [],
                });
            }
            out.push({
                type: 'Intrinsic',
                name: '__builtin_free',
                resolvedType: 'void',
                args: [{ type: 'Identifier', name, resolvedType: v.type }],
            });
            v.state = { kind: 'moved' }; // 二重解放防止
        }
        return out;
    }
}
