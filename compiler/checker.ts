// compiler/checker.ts — 型チェッカー + 脱糖 → IR JSON

import * as A from './ast';
import * as IR from '../interpreter/types';

// ── エラー ────────────────────────────────────────────────────────────────────

export class CheckError extends Error {
    constructor(msg: string, public pos?: A.Pos) {
        super(pos ? `${pos.file}:${pos.line}:${pos.col}: CheckError: ${msg}` : `CheckError: ${msg}`);
    }
}

// ── __builtin_* 戻り型テーブル ────────────────────────────────────────────────

const BUILTIN_RET: Record<string, string> = {
    // i32
    __builtin_i32_add: '_m32', __builtin_i32_sub: '_m32', __builtin_i32_mul: '_m32',
    __builtin_i32_div: '_m32', __builtin_i32_mod: '_m32', __builtin_i32_neg: '_m32',
    __builtin_i32_eq:  '_m32', __builtin_i32_lt:  '_m32', __builtin_i32_gt:  '_m32',
    __builtin_i32_or:  '_m32', __builtin_i32_and: '_m32', __builtin_i32_not: '_m32',
    __builtin_i32_shl: '_m32', __builtin_i32_shr: '_m32',
    __builtin_i32_rotl:'_m32', __builtin_i32_rotr:'_m32',
    __builtin_i32_clz: '_m32', __builtin_i32_ctz: '_m32', __builtin_i32_popcnt:'_m32',
    __builtin_i32_bitwise_and: '_m32', __builtin_i32_bitwise_or:  '_m32',
    __builtin_i32_bitwise_xor: '_m32', __builtin_i32_shift_left:  '_m32',
    __builtin_i32_shift_right: '_m32',
    // u32
    __builtin_u32_add: '_m32', __builtin_u32_sub: '_m32', __builtin_u32_mul: '_m32',
    __builtin_u32_div: '_m32', __builtin_u32_mod: '_m32',
    __builtin_u32_eq:  '_m32', __builtin_u32_lt:  '_m32', __builtin_u32_gt:  '_m32',
    __builtin_u32_or:  '_m32', __builtin_u32_and: '_m32',
    __builtin_u32_shl: '_m32', __builtin_u32_shr: '_m32',
    __builtin_u32_bitwise_and: '_m32', __builtin_u32_bitwise_or:  '_m32',
    __builtin_u32_bitwise_xor: '_m32', __builtin_u32_shift_left:  '_m32',
    __builtin_u32_shift_right: '_m32',
    // f32
    __builtin_f32_add: '_m32', __builtin_f32_sub: '_m32', __builtin_f32_mul: '_m32',
    __builtin_f32_div: '_m32', __builtin_f32_mod: '_m32', __builtin_f32_neg: '_m32',
    __builtin_f32_eq:  '_m32', __builtin_f32_lt:  '_m32', __builtin_f32_gt:  '_m32',
    __builtin_f32_abs: '_m32', __builtin_f32_sqrt:'_m32', __builtin_f32_floor:'_m32',
    __builtin_f32_ceil:'_m32', __builtin_f32_trunc:'_m32',__builtin_f32_nearest:'_m32',
    __builtin_f32_min: '_m32', __builtin_f32_max: '_m32',
    __builtin_f32_sin: '_m32', __builtin_f32_cos: '_m32', __builtin_f32_tan:  '_m32',
    __builtin_f32_exp: '_m32', __builtin_f32_log: '_m32', __builtin_f32_pow:  '_m32',
    __builtin_f32_atan:'_m32', __builtin_f32_atan2:'_m32',
    // i64
    __builtin_i64_add: '_m64', __builtin_i64_sub: '_m64', __builtin_i64_mul: '_m64',
    __builtin_i64_div: '_m64', __builtin_i64_mod: '_m64', __builtin_i64_neg: '_m64',
    __builtin_i64_eq:  '_m64', __builtin_i64_lt:  '_m64', __builtin_i64_gt:  '_m64',
    __builtin_i64_or:  '_m64', __builtin_i64_and: '_m64', __builtin_i64_not: '_m64',
    __builtin_i64_shl: '_m64', __builtin_i64_shr: '_m64',
    __builtin_i64_rotl:'_m64', __builtin_i64_rotr:'_m64',
    __builtin_i64_clz: '_m64', __builtin_i64_ctz: '_m64', __builtin_i64_popcnt:'_m64',
    // u64
    __builtin_u64_add: '_m64', __builtin_u64_sub: '_m64', __builtin_u64_mul: '_m64',
    __builtin_u64_div: '_m64', __builtin_u64_mod: '_m64',
    __builtin_u64_eq:  '_m64', __builtin_u64_lt:  '_m64', __builtin_u64_gt:  '_m64',
    __builtin_u64_or:  '_m64', __builtin_u64_and: '_m64', __builtin_u64_not: '_m64',
    __builtin_u64_shl: '_m64', __builtin_u64_shr: '_m64',
    // f64
    __builtin_f64_add: '_m64', __builtin_f64_sub: '_m64', __builtin_f64_mul: '_m64',
    __builtin_f64_div: '_m64', __builtin_f64_mod: '_m64', __builtin_f64_neg: '_m64',
    __builtin_f64_eq:  '_m64', __builtin_f64_lt:  '_m64', __builtin_f64_gt:  '_m64',
    __builtin_f64_abs: '_m64', __builtin_f64_sqrt:'_m64', __builtin_f64_floor:'_m64',
    __builtin_f64_ceil:'_m64', __builtin_f64_trunc:'_m64',__builtin_f64_nearest:'_m64',
    __builtin_f64_min: '_m64', __builtin_f64_max: '_m64',
    __builtin_f64_sin: '_m64', __builtin_f64_cos: '_m64', __builtin_f64_tan:  '_m64',
    __builtin_f64_exp: '_m64', __builtin_f64_log: '_m64', __builtin_f64_pow:  '_m64',
    __builtin_f64_atan:'_m64', __builtin_f64_atan2:'_m64',
    // 型変換
    __builtin_i32_to_f32: '_m32', __builtin_f32_to_i32: '_m32',
    __builtin_i32_to_u32: '_m32', __builtin_u32_to_i32: '_m32',
    __builtin_u32_to_f32: '_m32', __builtin_f32_to_u32: '_m32',
    __builtin_i32_to_i64: '_m64', __builtin_u32_to_u64: '_m64',
    __builtin_i64_to_i32: '_m32', __builtin_u64_to_u32: '_m32',
    __builtin_f32_to_f64: '_m64', __builtin_f64_to_f32: '_m32',
    __builtin_f64_to_i64: '_m64', __builtin_i64_to_f64: '_m64',
    __builtin_u64_to_f64: '_m64',
    __builtin_i32_to_f64: '_m64', __builtin_u32_to_f64: '_m64',
    // メモリ
    __builtin_malloc:       '_m32', __builtin_free:        'void',
    __builtin_mem_read8:    '_m32', __builtin_mem_read16:  '_m32',
    __builtin_mem_read32:   '_m32', __builtin_mem_read64:  '_m64',
    __builtin_mem_write8:   'void', __builtin_mem_write16: 'void',
    __builtin_mem_write32:  'void', __builtin_mem_write64: 'void',
    __builtin_zeroinit:     '_m32',
    __builtin_ptr_alloc:    '_m32', __builtin_ptr_read:    '_m32',
    __builtin_ptr_write:    'void', __builtin_ptr_realloc: '_m32',
    __builtin_ptr_free:     'void', __builtin_ptr_copy:    'void',
    __builtin_mem_set:      'void',
    __builtin_sizeof:       '_m32',
    // I/O
    __builtin_stdout_write: 'void', __builtin_stderr_write:'void',
    __builtin_stdin_read:   '_m32', __builtin_stdin_readline:'string',
    __builtin_str_length:   '_m32',
    __builtin_panic:        'void',
    __builtin_if:           '_m32', __builtin_while:       '_m32',
    // スレッド
    __builtin_thread_spawn:        '_m64',
    __builtin_thread_join:         'void',
    __builtin_threadpool_create:   '_m64',
    __builtin_threadpool_submit:   'void',
    __builtin_threadpool_wait:     'void',
    __builtin_threadpool_destroy:  'void',
    __builtin_mutex_create:        '_m64',
    __builtin_mutex_lock:          'void',
    __builtin_mutex_unlock:        'void',
    __builtin_condvar_create:      '_m64',
    __builtin_condvar_wait:        'void',
    __builtin_condvar_signal:      'void',
    __builtin_condvar_broadcast:   'void',
    __builtin_atomic_load:         '_m32',
    __builtin_atomic_store:        'void',
    __builtin_atomic_cas:          '_m32',
    __builtin_atomic_fetch_add:    '_m32',
    __builtin_atomic_fetch_sub:    '_m32',
};

// ── ヘルパー ──────────────────────────────────────────────────────────────────

function splitTypeArgs(s: string): string[] {
    const result: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '<') depth++;
        else if (s[i] === '>') depth--;
        else if (s[i] === ',' && depth === 0) {
            result.push(s.slice(start, i).trim());
            start = i + 1;
        }
    }
    const last = s.slice(start).trim();
    if (last.length > 0) result.push(last);
    return result;
}

function applySubst(type: string, subst: Map<string, string>): string {
    const direct = subst.get(type);
    if (direct !== undefined) return direct;
    const lt = type.indexOf('<');
    if (lt === -1) return type;
    const base = type.slice(0, lt);
    const inner = type.slice(lt + 1, type.lastIndexOf('>'));
    const args = splitTypeArgs(inner).map(a => applySubst(a, subst));
    return `${base}<${args.join(',')}>`;
}

function resolvedType(node: IR.ASTNode): string {
    switch (node.type) {
        case 'Identifier':   return node.resolvedType;
        case 'MethodCall':   return node.resolvedType;
        case 'NewExpr':      return node.resolvedType;
        case 'Intrinsic':    return node.resolvedType;
        case 'MemberAccess': return node.resolvedType;
        case 'RawLiteral':   return '_m32';
        default:             return 'void';
    }
}

// ── Registry ──────────────────────────────────────────────────────────────────

export interface Registry {
    classEnv:    Map<string, IR.ClassDecl>;
    funcEnv:     Map<string, IR.FunctionDecl>;
    typeAliases: Map<string, string>;
    globalEnv:   Map<string, { type: string; mut: boolean }>;
    namespaces:  Set<string>;
}

export function emptyRegistry(): Registry {
    return { classEnv: new Map(), funcEnv: new Map(), typeAliases: new Map(), globalEnv: new Map(), namespaces: new Set() };
}

// ── 検査コンテキスト ──────────────────────────────────────────────────────────

interface CheckCtx {
    isMoc:      boolean;
    locals:     Map<string, { type: string; mut: boolean }>;
    thisType:   string | null;
    returnType: string;
    inLitCtx:   boolean;  // .moc コンストラクタ引数内ならリテラル許可
}

// ── Checker ───────────────────────────────────────────────────────────────────

export class Checker {
    constructor(private reg: Registry) {}

    // ファイル全体を検査して IR ノードを返す
    check(file: A.PFile): IR.ASTNode[] {
        const { isMoc } = file;
        const nodes: IR.ASTNode[] = [];

        // Pass 1: 全宣言をレジストリに登録
        for (const decl of file.decls) {
            this.registerDecl(decl, isMoc);
        }

        // Pass 2: 各宣言を検査して IR ノードを出力
        for (const decl of file.decls) {
            nodes.push(this.checkTopDecl(decl, isMoc));
        }

        return nodes;
    }

    // ── Pass 1: 登録 ─────────────────────────────────────────────────────────

    private registerDecl(decl: A.PTopLevelDecl, isMoc: boolean): void {
        switch (decl.kind) {
            case 'import': {
                if (decl.namespace !== null) {
                    this.reg.namespaces.add(decl.namespace);
                }
                break;
            }
            case 'typealias': {
                const resolved = this.resolveType(decl.type, isMoc);
                this.reg.typeAliases.set(decl.name, resolved);
                break;
            }
            case 'vardecl': {
                const rt = this.resolveType(decl.type, isMoc);
                this.reg.globalEnv.set(decl.name, { type: rt, mut: decl.mut });
                break;
            }
            case 'class': {
                // クラスのスタブをレジストリに追加（Pass 2 で完成）
                if (!this.reg.classEnv.has(decl.name)) {
                    this.reg.classEnv.set(decl.name, {
                        type: 'ClassDecl', name: decl.name, access: decl.access,
                        typeParams: decl.typeParams, members: [], methods: [],
                    });
                }
                break;
            }
            case 'function': {
                const params = decl.params.map(p => ({
                    name: p.name, resolvedType: this.resolveType(p.type, isMoc),
                }));
                this.reg.funcEnv.set(decl.name, {
                    type: 'FunctionDecl', name: decl.name, access: decl.access,
                    typeParams: decl.typeParams, params,
                    returnType: this.resolveType(decl.returnType, isMoc),
                    body: [],
                });
                break;
            }
            default: break;
        }
    }

    // ── Pass 2: 検査 ─────────────────────────────────────────────────────────

    private checkTopDecl(decl: A.PTopLevelDecl, isMoc: boolean): IR.ASTNode {
        switch (decl.kind) {
            case 'import':
                return { type: 'ImportDecl', path: decl.path, namespace: decl.namespace };

            case 'typealias': {
                const rt = this.reg.typeAliases.get(decl.name)
                    ?? this.resolveType(decl.type, isMoc);
                return { type: 'TypeAliasDecl', name: decl.name, resolvedType: rt };
            }

            case 'class':
                return this.checkClassDecl(decl, isMoc);

            case 'function': {
                const fn = this.checkFunctionDecl(decl, isMoc, null);
                this.reg.funcEnv.set(decl.name, fn);
                return fn;
            }

            case 'vardecl': {
                const rt = this.resolveType(decl.type, isMoc);
                const ctx: CheckCtx = {
                    isMoc, locals: new Map(), thisType: null,
                    returnType: 'void', inLitCtx: isMoc,
                };
                const value = this.checkExpr(decl.value, ctx);
                return { type: 'VarDecl', name: decl.name, resolvedType: rt, value };
            }
        }
    }

    // ── クラス宣言 ────────────────────────────────────────────────────────────

    private checkClassDecl(decl: A.PClassDecl, isMoc: boolean): IR.ClassDecl {
        const members: IR.FieldDecl[] = [];
        const methods: IR.FunctionDecl[] = [];

        // フィールドを収集
        for (const m of decl.members) {
            if (m.kind === 'field') {
                members.push({
                    type: 'FieldDecl', name: m.name, access: m.access,
                    resolvedType: this.resolveType(m.type, isMoc),
                });
            }
        }

        // ClassDecl をレジストリに設定（メソッドスタブと共有配列）
        const classDef: IR.ClassDecl = {
            type: 'ClassDecl', name: decl.name, access: decl.access,
            typeParams: decl.typeParams, members, methods,
        };
        this.reg.classEnv.set(decl.name, classDef);

        // メソッドスタブを先に全部登録（相互参照のため）
        for (const m of decl.members) {
            if (m.kind !== 'method') continue;
            const params = m.params.map(p => ({
                name: p.name, resolvedType: this.resolveType(p.type, isMoc),
            }));
            methods.push({
                type: 'FunctionDecl', name: m.name, access: m.access,
                typeParams: m.typeParams, params,
                returnType: this.resolveType(m.returnType, isMoc),
                body: [],
            });
        }

        // this の型: ジェネリクスがあれば Array<T> 形式
        const thisType = decl.typeParams.length > 0
            ? `${decl.name}<${decl.typeParams.join(',')}>`
            : decl.name;

        // 各メソッド本体を検査
        for (const m of decl.members) {
            if (m.kind !== 'method') continue;
            const stub = methods.find(s => s.name === m.name)!;
            const locals = new Map<string, { type: string; mut: boolean }>();
            for (const p of stub.params) {
                locals.set(p.name, { type: p.resolvedType, mut: true });
            }
            const ctx: CheckCtx = {
                isMoc, locals, thisType, returnType: stub.returnType, inLitCtx: false,
            };
            stub.body = this.checkBody(m.body, ctx);
        }

        return classDef;
    }

    // ── 関数宣言 ──────────────────────────────────────────────────────────────

    private checkFunctionDecl(
        decl: A.PFunctionDecl, isMoc: boolean, thisType: string | null,
    ): IR.FunctionDecl {
        const params = decl.params.map(p => ({
            name: p.name, resolvedType: this.resolveType(p.type, isMoc),
        }));
        const returnType = this.resolveType(decl.returnType, isMoc);
        const locals = new Map<string, { type: string; mut: boolean }>();
        for (const p of params) locals.set(p.name, { type: p.resolvedType, mut: true });

        const ctx: CheckCtx = { isMoc, locals, thisType, returnType, inLitCtx: false };
        const body = this.checkBody(decl.body, ctx);

        return {
            type: 'FunctionDecl', name: decl.name, access: decl.access,
            typeParams: decl.typeParams, params, returnType, body,
        };
    }

    // ── ブロック ──────────────────────────────────────────────────────────────

    private checkBody(stmts: A.PStmt[], ctx: CheckCtx): IR.ASTNode[] {
        const nodes: IR.ASTNode[] = [];
        const scopedCtx: CheckCtx = { ...ctx, locals: new Map(ctx.locals) };
        for (const stmt of stmts) {
            nodes.push(this.checkStmt(stmt, scopedCtx));
        }
        return nodes;
    }

    // ── 文 ────────────────────────────────────────────────────────────────────

    private checkStmt(stmt: A.PStmt, ctx: CheckCtx): IR.ASTNode {
        switch (stmt.kind) {
            case 'vardecl': {
                if (ctx.locals.has(stmt.name)) {
                    throw new CheckError(`'${stmt.name}' はシャドーイングできません`, stmt.pos);
                }
                const rt = this.resolveType(stmt.type, ctx.isMoc);
                const value = this.checkExpr(stmt.value, ctx);
                ctx.locals.set(stmt.name, { type: rt, mut: stmt.mut });
                return { type: 'VarDecl', name: stmt.name, resolvedType: rt, value };
            }

            case 'assign': {
                // const への再代入チェック
                if (stmt.target.kind === 'ident') {
                    const local = ctx.locals.get(stmt.target.name);
                    if (local && !local.mut) {
                        throw new CheckError(`const '${stmt.target.name}' には代入できません`, stmt.pos);
                    }
                }
                // a[i] = v → operator_set[]
                if (stmt.target.kind === 'index') {
                    const obj = this.checkExpr((stmt.target as A.PIndexExpr).obj, ctx);
                    const idx = this.checkExpr((stmt.target as A.PIndexExpr).index, ctx);
                    const val = this.checkExpr(stmt.value, ctx);
                    const rt = this.methodReturnType(resolvedType(obj), 'operator_set[]');
                    return { type: 'MethodCall', resolvedType: rt, receiver: obj, method: 'operator_set[]', args: [idx, val] };
                }
                return { type: 'Assign', target: this.checkExpr(stmt.target, ctx), value: this.checkExpr(stmt.value, ctx) };
            }

            case 'exprstmt':
                return this.checkExpr(stmt.expr, ctx);

            case 'if': {
                const cond: IR.Intrinsic = {
                    type: 'Intrinsic', name: '__builtin_if', resolvedType: '_m32',
                    args: [this.checkExpr(stmt.cond, ctx)],
                };
                const body = this.checkBody(stmt.body, ctx);
                let elseNode: IR.IfStmt | IR.ElseStmt | null = null;
                if (stmt.elseIf) {
                    elseNode = this.checkStmt(stmt.elseIf, ctx) as IR.IfStmt;
                } else if (stmt.elseBody) {
                    elseNode = { type: 'ElseStmt', body: this.checkBody(stmt.elseBody, ctx) };
                }
                return { type: 'IfStmt', cond, body, else: elseNode };
            }

            case 'while': {
                const cond: IR.Intrinsic = {
                    type: 'Intrinsic', name: '__builtin_while', resolvedType: '_m32',
                    args: [this.checkExpr(stmt.cond, ctx)],
                };
                return { type: 'WhileStmt', cond, body: this.checkBody(stmt.body, ctx) };
            }

            case 'for': {
                const forCtx: CheckCtx = { ...ctx, locals: new Map(ctx.locals) };

                const initRt = this.resolveType(stmt.init.type, ctx.isMoc);
                const initValue = this.checkExpr(stmt.init.value, forCtx);
                const init: IR.VarDecl = { type: 'VarDecl', name: stmt.init.name, resolvedType: initRt, value: initValue };
                forCtx.locals.set(stmt.init.name, { type: initRt, mut: stmt.init.mut });

                const cond: IR.Intrinsic = {
                    type: 'Intrinsic', name: '__builtin_if', resolvedType: '_m32',
                    args: [this.checkExpr(stmt.cond, forCtx)],
                };

                let update: IR.ASTNode;
                if (stmt.update.kind === 'assign') {
                    const upd = stmt.update as A.PAssignStmt;
                    if (upd.target.kind === 'index') {
                        const obj = this.checkExpr((upd.target as A.PIndexExpr).obj, forCtx);
                        const idx = this.checkExpr((upd.target as A.PIndexExpr).index, forCtx);
                        const val = this.checkExpr(upd.value, forCtx);
                        const rt = this.methodReturnType(resolvedType(obj), 'operator_set[]');
                        update = { type: 'MethodCall', resolvedType: rt, receiver: obj, method: 'operator_set[]', args: [idx, val] };
                    } else {
                        update = { type: 'Assign', target: this.checkExpr(upd.target, forCtx), value: this.checkExpr(upd.value, forCtx) };
                    }
                } else {
                    update = this.checkExpr((stmt.update as A.PExprStmt).expr, forCtx);
                }

                return { type: 'ForStmt', init, cond, update, body: this.checkBody(stmt.body, forCtx) };
            }

            case 'return': {
                if (stmt.value === null) return { type: 'ReturnStmt', value: null };
                return { type: 'ReturnStmt', value: this.checkExpr(stmt.value, ctx) };
            }

            case 'break':
                return { type: 'BreakStmt' };

            case 'block':
                return { type: 'BlockStmt', body: this.checkBody(stmt.body, ctx) };
        }
    }

    // ── 式 ────────────────────────────────────────────────────────────────────

    private checkExpr(expr: A.PExpr, ctx: CheckCtx): IR.ASTNode {
        switch (expr.kind) {

            case 'ident': {
                const local = ctx.locals.get(expr.name);
                if (local) {
                    return { type: 'Identifier', name: expr.name, resolvedType: local.type };
                }
                const fn = this.reg.funcEnv.get(expr.name);
                if (fn) {
                    return { type: 'Identifier', name: expr.name, resolvedType: fn.returnType };
                }
                const global = this.reg.globalEnv.get(expr.name);
                if (global) {
                    return { type: 'Identifier', name: expr.name, resolvedType: global.type };
                }
                throw new CheckError(`未定義の識別子 '${expr.name}'`, expr.pos);
            }

            case 'this': {
                if (!ctx.thisType) throw new CheckError(`クラス外で this は使えません`, expr.pos);
                return { type: 'Identifier', name: 'this', resolvedType: ctx.thisType };
            }

            case 'intlit': {
                if (!ctx.inLitCtx) throw new CheckError(`整数リテラルはコンストラクタ引数内のみ使用可能`, expr.pos);
                return { type: 'RawLiteral', kind: 'int', value: expr.value };
            }

            case 'floatlit': {
                if (!ctx.inLitCtx) throw new CheckError(`浮動小数点リテラルはコンストラクタ引数内のみ使用可能`, expr.pos);
                return { type: 'RawLiteral', kind: 'float', value: expr.value };
            }

            case 'boollit': {
                if (!ctx.inLitCtx) throw new CheckError(`真偽値リテラルはコンストラクタ引数内のみ使用可能`, expr.pos);
                return { type: 'RawLiteral', kind: 'int', value: expr.value ? 1 : 0 };
            }

            case 'strlit': {
                // 文字列リテラル → Array<u32> with elements
                const elements: IR.RawLiteral[] = [];
                for (let i = 0; i < expr.value.length; i++) {
                    elements.push({ type: 'RawLiteral', kind: 'char', value: expr.value.charCodeAt(i) });
                }
                return { type: 'NewExpr', resolvedType: 'Array<u32>', args: [], elements };
            }

            case 'new': {
                const rt = this.resolveType(expr.type, ctx.isMoc);
                // コンストラクタ引数内ではリテラル許可
                const litCtx: CheckCtx = { ...ctx, inLitCtx: true };
                const args = expr.args.map(a => this.checkExpr(a, litCtx));
                return { type: 'NewExpr', resolvedType: rt, args };
            }

            case 'unary': {
                const operand = this.checkExpr(expr.expr, ctx);
                const recvType = resolvedType(operand);
                if (expr.op === '!') {
                    const rt = this.methodReturnType(recvType, 'operatorNot');
                    return { type: 'MethodCall', resolvedType: rt, receiver: operand, method: 'operatorNot', args: [] };
                }
                if (expr.op === '-') {
                    // リテラルコンテキスト内の負数リテラル: RawLiteral を直接否定
                    if (operand.type === 'RawLiteral') {
                        return { type: 'RawLiteral', kind: operand.kind, value: -(operand as any).value };
                    }
                    // 単項マイナスは negate() メソッドへ脱糖（§6.5）。
                    // negate を持たない型（u32/u64 等）はここでコンパイルエラーにする
                    const baseName = recvType.replace(/<.*>$/, '');
                    const cls = this.reg.classEnv.get(baseName);
                    if (!cls || !cls.methods.some(m => m.name === 'negate')) {
                        throw new CheckError(`型 '${recvType}' は単項マイナス（negate メソッド）に対応していません`, expr.pos);
                    }
                    const rt = this.methodReturnType(recvType, 'negate');
                    return { type: 'MethodCall', resolvedType: rt, receiver: operand, method: 'negate', args: [] };
                }
                throw new CheckError(`未知の単項演算子 '${expr.op}'`, expr.pos);
            }

            case 'bin': {
                // <= と >= は脱糖
                if (expr.op === '<=' || expr.op === '>=') {
                    const cmpOp = expr.op === '<=' ? 'operator<' : 'operator>';
                    const l1 = this.checkExpr(expr.left, ctx);
                    const r1 = this.checkExpr(expr.right, ctx);
                    const l2 = this.checkExpr(expr.left, ctx);
                    const r2 = this.checkExpr(expr.right, ctx);
                    const lt = resolvedType(l1);
                    const cmpNode = this.makeCall(l1, cmpOp, [r1], lt);
                    const eqNode  = this.makeCall(l2, 'operator==', [r2], lt);
                    return this.makeCall(cmpNode, 'operator||', [eqNode], resolvedType(cmpNode));
                }
                // != は脱糖
                if (expr.op === '!=') {
                    const l = this.checkExpr(expr.left, ctx);
                    const r = this.checkExpr(expr.right, ctx);
                    const eq = this.makeCall(l, 'operator==', [r], resolvedType(l));
                    return this.makeCall(eq, 'operatorNot', [], resolvedType(eq));
                }
                const OP_MAP: Record<string, string> = {
                    '+': 'operator+', '-': 'operator-', '*': 'operator*',
                    '/': 'operator/', '%': 'operator%',
                    '==': 'operator==', '<': 'operator<', '>': 'operator>',
                    '||': 'operator||', '&&': 'operator&&',
                };
                const method = OP_MAP[expr.op];
                if (!method) throw new CheckError(`未知の二項演算子 '${expr.op}'`, expr.pos);
                const left  = this.checkExpr(expr.left, ctx);
                const right = this.checkExpr(expr.right, ctx);
                return this.makeCall(left, method, [right], resolvedType(left));
            }

            case 'call': {
                // __builtin_* → Intrinsic ノード
                if (expr.name.startsWith('__builtin_')) {
                    if (!ctx.isMoc) {
                        throw new CheckError(`組み込み関数は .moc ファイル内のみ使用可能`, expr.pos);
                    }
                    const rt = BUILTIN_RET[expr.name] ?? '_m32';
                    const args = expr.args.map(a => this.checkExpr(a, ctx));
                    const node: IR.Intrinsic = { type: 'Intrinsic', name: expr.name, resolvedType: rt, args };
                    if (expr.name === '__builtin_sizeof' && expr.typeArgs.length > 0) {
                        node.targetType = this.resolveType(expr.typeArgs[0], ctx.isMoc);
                    }
                    return node;
                }
                // トップレベル関数呼び出し
                const fn = this.reg.funcEnv.get(expr.name);
                if (!fn) throw new CheckError(`未知の関数 '${expr.name}'`, expr.pos);
                const subst = new Map<string, string>();
                fn.typeParams.forEach((tp, i) => {
                    if (expr.typeArgs[i]) subst.set(tp, this.resolveType(expr.typeArgs[i], ctx.isMoc));
                });
                const rt = applySubst(fn.returnType, subst);
                const args = expr.args.map(a => this.checkExpr(a, ctx));
                // 関数呼び出しを MethodCall としてエンコード（receiver は識別子）
                return {
                    type: 'MethodCall', resolvedType: rt,
                    receiver: { type: 'Identifier', name: expr.name, resolvedType: rt },
                    method: expr.name, args,
                };
            }

            case 'methodcall': {
                // 名前空間付き関数呼び出し: Geo.max<i32>(...)
                if (expr.obj.kind === 'ident' && this.reg.namespaces.has(expr.obj.name)) {
                    const fn = this.reg.funcEnv.get(expr.method);
                    if (!fn) throw new CheckError(`未知の関数 '${expr.obj.name}.${expr.method}'`, expr.pos);
                    const subst = new Map<string, string>();
                    fn.typeParams.forEach((tp, i) => {
                        if (expr.typeArgs[i]) subst.set(tp, this.resolveType(expr.typeArgs[i], ctx.isMoc));
                    });
                    const rt = applySubst(fn.returnType, subst);
                    const args = expr.args.map(a => this.checkExpr(a, ctx));
                    const qualifiedName = `${expr.obj.name}.${expr.method}`;
                    return {
                        type: 'MethodCall', resolvedType: rt,
                        receiver: { type: 'Identifier', name: qualifiedName, resolvedType: rt },
                        method: qualifiedName, args,
                    };
                }
                const obj = this.checkExpr(expr.obj, ctx);
                const objType = resolvedType(obj);
                const args = expr.args.map(a => this.checkExpr(a, ctx));
                const rt = this.methodReturnType(objType, expr.method);
                return { type: 'MethodCall', resolvedType: rt, receiver: obj, method: expr.method, args };
            }

            case 'index': {
                // a[i] → operator[]
                const obj = this.checkExpr(expr.obj, ctx);
                const idx = this.checkExpr(expr.index, ctx);
                const rt = this.methodReturnType(resolvedType(obj), 'operator[]');
                return { type: 'MethodCall', resolvedType: rt, receiver: obj, method: 'operator[]', args: [idx] };
            }

            case 'member': {
                const obj = this.checkExpr(expr.obj, ctx);
                const ft = this.fieldType(resolvedType(obj), expr.member);
                return { type: 'MemberAccess', resolvedType: ft, receiver: obj, member: expr.member };
            }
        }
    }

    // ── 型解決 ────────────────────────────────────────────────────────────────

    resolveType(pt: A.PType, isMoc: boolean): string {
        const MOC_ONLY = ['_m8', '_m16', '_m32', '_m64', '_m128', '_m256', '_m512'];
        // 名前空間付き型名 (Geo.Vec2) → 単純名 (Vec2) に正規化
        const simpleName = pt.name.includes('.') ? pt.name.slice(pt.name.lastIndexOf('.') + 1) : pt.name;
        if (MOC_ONLY.includes(simpleName) && !isMoc) {
            throw new CheckError(`型 '${simpleName}' は .moc ファイル内でのみ使用可能`);
        }
        if (pt.args.length === 0) {
            // エイリアス展開（連鎖対応）
            let name = simpleName;
            const seen = new Set<string>();
            while (this.reg.typeAliases.has(name) && !seen.has(name)) {
                seen.add(name);
                name = this.reg.typeAliases.get(name)!;
            }
            return name;
        }
        // ジェネリクス型
        const resolvedArgs = pt.args.map(a => this.resolveType(a, isMoc));
        return `${simpleName}<${resolvedArgs.join(',')}>`;
    }

    // ── メソッド戻り型取得 ────────────────────────────────────────────────────

    private methodReturnType(receiverType: string, methodName: string): string {
        const lt = receiverType.indexOf('<');
        const baseName = lt === -1 ? receiverType : receiverType.slice(0, lt);
        const cls = this.reg.classEnv.get(baseName);
        if (!cls) return 'void';

        // 型パラメータ代入マップを構築
        const subst = new Map<string, string>();
        if (lt !== -1 && cls.typeParams.length > 0) {
            const inner = receiverType.slice(lt + 1, receiverType.lastIndexOf('>'));
            splitTypeArgs(inner).forEach((arg, i) => {
                if (cls.typeParams[i]) subst.set(cls.typeParams[i], arg);
            });
        }

        const method = cls.methods.find(m => m.name === methodName);
        if (!method) return 'void';
        return applySubst(method.returnType, subst);
    }

    // ── フィールド型取得 ──────────────────────────────────────────────────────

    private fieldType(receiverType: string, fieldName: string): string {
        const lt = receiverType.indexOf('<');
        const baseName = lt === -1 ? receiverType : receiverType.slice(0, lt);
        const cls = this.reg.classEnv.get(baseName);
        if (!cls) return '_m32';

        const subst = new Map<string, string>();
        if (lt !== -1 && cls.typeParams.length > 0) {
            const inner = receiverType.slice(lt + 1, receiverType.lastIndexOf('>'));
            splitTypeArgs(inner).forEach((arg, i) => {
                if (cls.typeParams[i]) subst.set(cls.typeParams[i], arg);
            });
        }

        const field = cls.members.find(f => f.name === fieldName);
        if (!field) return '_m32';
        return applySubst(field.resolvedType, subst);
    }

    // ── MethodCall ノード生成ヘルパー ─────────────────────────────────────────

    private makeCall(receiver: IR.ASTNode, method: string, args: IR.ASTNode[], receiverType: string): IR.MethodCall {
        return {
            type: 'MethodCall',
            resolvedType: this.methodReturnType(receiverType, method),
            receiver, method, args,
        };
    }
}
