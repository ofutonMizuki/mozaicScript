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
    // GPU バッファ・能力照会（コアライブラリ §8.2）
    __builtin_gpu_buffer_create:           '_m64',
    __builtin_gpu_is_available:            '_m32',
    __builtin_gpu_buffer_map_write:        '_m32',
    __builtin_gpu_buffer_map_read:         '_m32',
    __builtin_gpu_buffer_unmap:            'void',
    __builtin_gpu_buffer_byte_size:        '_m64',
    __builtin_gpu_buffer_free:             'void',
    // GPU カーネル（§8.3.1）
    __builtin_gpu_kernel_name:             'string',
    __builtin_gpu_kernel_workgroup_size_x: '_m32',
    __builtin_gpu_kernel_workgroup_size_y: '_m32',
    __builtin_gpu_kernel_workgroup_size_z: '_m32',
    // GPU 引数ビルダー（§8.3.2）
    __builtin_gpu_args_create:             '_m64',
    __builtin_gpu_args_push_buffer:        'void',
    __builtin_gpu_args_push_i32:           'void',
    __builtin_gpu_args_push_u32:           'void',
    __builtin_gpu_args_push_i64:           'void',
    __builtin_gpu_args_push_u64:           'void',
    __builtin_gpu_args_push_f32:           'void',
    __builtin_gpu_args_push_f64:           'void',
    __builtin_gpu_args_push_boolean:       'void',
    __builtin_gpu_args_count:              '_m32',
    __builtin_gpu_args_clear:              'void',
    // GPU ディスパッチ（§8.3.3）
    __builtin_gpu_dispatch:                'void',
    __builtin_gpu_sync:                    'void',
    __builtin_gpu_flush:                   'void',
    // GPU カーネルハンドル解決 (コンパイラが自動生成する GpuKernel 定数の初期化に挿入)
    __builtin_gpu_kernel_handle:           '_m64',
    // GPU カーネル本体内で利用される thread/workgroup ID intrinsics
    // (フロントエンドが §14.4 の gpuGlobalId() 等を lower した先)
    __builtin_gpu_thread_global_id_x:      '_m32',
    __builtin_gpu_thread_global_id_y:      '_m32',
    __builtin_gpu_thread_global_id_z:      '_m32',
    __builtin_gpu_thread_local_id_x:       '_m32',
    __builtin_gpu_thread_local_id_y:       '_m32',
    __builtin_gpu_thread_local_id_z:       '_m32',
    __builtin_gpu_thread_workgroup_id_x:   '_m32',
    __builtin_gpu_thread_workgroup_id_y:   '_m32',
    __builtin_gpu_thread_workgroup_id_z:   '_m32',
    __builtin_gpu_thread_workgroup_size:   '_m32',
    __builtin_gpu_barrier:                 'void',
    __builtin_gpu_storage_barrier:         'void',
    __builtin_gpu_atomic_add_u32:          '_m32',
    __builtin_gpu_atomic_sub_u32:          '_m32',
    __builtin_gpu_atomic_min_u32:          '_m32',
    __builtin_gpu_atomic_max_u32:          '_m32',
    __builtin_gpu_atomic_cas_u32:          '_m32',
    __builtin_gpu_atomic_load_u32:         '_m32',
    __builtin_gpu_atomic_store_u32:        'void',
    __builtin_gpu_atomic_add_i32:          '_m32',
    __builtin_gpu_atomic_sub_i32:          '_m32',
    __builtin_gpu_atomic_min_i32:          '_m32',
    __builtin_gpu_atomic_max_i32:          '_m32',
    __builtin_gpu_atomic_cas_i32:          '_m32',
    __builtin_gpu_atomic_load_i32:         '_m32',
    __builtin_gpu_atomic_store_i32:        'void',
    __builtin_gpu_fma:                     '_m32',
    __builtin_gpu_dot_f32x4:               '_m32',
};

// §14.4: gpu 関数本体内でのみ呼べる組み込み関数。.moz から普通の関数呼び出し構文で参照され
// チェッカーが Intrinsic ノードに lower する。 戻り型は IR 上の resolvedType (ラッパー型名)。
interface GpuBuiltinSig {
    intrinsic: string;
    returnType: string;       // mozaicScript 型 (i32 / u32 / f32 / void / boolean)
    paramTypes: string[];     // 期待される引数型 (簡易検査用)
}
const GPU_BUILTINS: Record<string, GpuBuiltinSig> = {
    // §14.4.1 thread/workgroup ID
    gpuGlobalId:        { intrinsic: '__builtin_gpu_thread_global_id_x',    returnType: 'u32', paramTypes: [] },
    gpuGlobalIdX:       { intrinsic: '__builtin_gpu_thread_global_id_x',    returnType: 'u32', paramTypes: [] },
    gpuGlobalIdY:       { intrinsic: '__builtin_gpu_thread_global_id_y',    returnType: 'u32', paramTypes: [] },
    gpuGlobalIdZ:       { intrinsic: '__builtin_gpu_thread_global_id_z',    returnType: 'u32', paramTypes: [] },
    gpuLocalId:         { intrinsic: '__builtin_gpu_thread_local_id_x',     returnType: 'u32', paramTypes: [] },
    gpuLocalIdX:        { intrinsic: '__builtin_gpu_thread_local_id_x',     returnType: 'u32', paramTypes: [] },
    gpuLocalIdY:        { intrinsic: '__builtin_gpu_thread_local_id_y',     returnType: 'u32', paramTypes: [] },
    gpuLocalIdZ:        { intrinsic: '__builtin_gpu_thread_local_id_z',     returnType: 'u32', paramTypes: [] },
    gpuWorkgroupId:     { intrinsic: '__builtin_gpu_thread_workgroup_id_x', returnType: 'u32', paramTypes: [] },
    gpuWorkgroupIdX:    { intrinsic: '__builtin_gpu_thread_workgroup_id_x', returnType: 'u32', paramTypes: [] },
    gpuWorkgroupIdY:    { intrinsic: '__builtin_gpu_thread_workgroup_id_y', returnType: 'u32', paramTypes: [] },
    gpuWorkgroupIdZ:    { intrinsic: '__builtin_gpu_thread_workgroup_id_z', returnType: 'u32', paramTypes: [] },
    gpuWorkgroupSize:   { intrinsic: '__builtin_gpu_thread_workgroup_size', returnType: 'u32', paramTypes: [] },
    // §14.4.2 同期バリア
    gpuBarrier:         { intrinsic: '__builtin_gpu_barrier',         returnType: 'void', paramTypes: [] },
    gpuStorageBarrier:  { intrinsic: '__builtin_gpu_storage_barrier', returnType: 'void', paramTypes: [] },
    // §14.4.3 アトミック (u32)
    gpuAtomicAdd:       { intrinsic: '__builtin_gpu_atomic_add_u32',   returnType: 'u32', paramTypes: ['Ptr<u32>', 'u32'] },
    gpuAtomicSub:       { intrinsic: '__builtin_gpu_atomic_sub_u32',   returnType: 'u32', paramTypes: ['Ptr<u32>', 'u32'] },
    gpuAtomicMin:       { intrinsic: '__builtin_gpu_atomic_min_u32',   returnType: 'u32', paramTypes: ['Ptr<u32>', 'u32'] },
    gpuAtomicMax:       { intrinsic: '__builtin_gpu_atomic_max_u32',   returnType: 'u32', paramTypes: ['Ptr<u32>', 'u32'] },
    gpuCompareExchange: { intrinsic: '__builtin_gpu_atomic_cas_u32',   returnType: 'u32', paramTypes: ['Ptr<u32>', 'u32', 'u32'] },
    gpuAtomicLoad:      { intrinsic: '__builtin_gpu_atomic_load_u32',  returnType: 'u32', paramTypes: ['Ptr<u32>'] },
    gpuAtomicStore:     { intrinsic: '__builtin_gpu_atomic_store_u32', returnType: 'void', paramTypes: ['Ptr<u32>', 'u32'] },
    // §14.4.3 アトミック (i32)
    gpuAtomicAddI32:    { intrinsic: '__builtin_gpu_atomic_add_i32',   returnType: 'i32', paramTypes: ['Ptr<i32>', 'i32'] },
    gpuAtomicSubI32:    { intrinsic: '__builtin_gpu_atomic_sub_i32',   returnType: 'i32', paramTypes: ['Ptr<i32>', 'i32'] },
    gpuAtomicMinI32:    { intrinsic: '__builtin_gpu_atomic_min_i32',   returnType: 'i32', paramTypes: ['Ptr<i32>', 'i32'] },
    gpuAtomicMaxI32:    { intrinsic: '__builtin_gpu_atomic_max_i32',   returnType: 'i32', paramTypes: ['Ptr<i32>', 'i32'] },
    gpuCompareExchangeI32: { intrinsic: '__builtin_gpu_atomic_cas_i32', returnType: 'i32', paramTypes: ['Ptr<i32>', 'i32', 'i32'] },
    gpuAtomicLoadI32:   { intrinsic: '__builtin_gpu_atomic_load_i32',  returnType: 'i32', paramTypes: ['Ptr<i32>'] },
    gpuAtomicStoreI32:  { intrinsic: '__builtin_gpu_atomic_store_i32', returnType: 'void', paramTypes: ['Ptr<i32>', 'i32'] },
    // §14.4.4 数値ユーティリティ
    gpuFma:             { intrinsic: '__builtin_gpu_fma',       returnType: 'f32', paramTypes: ['f32', 'f32', 'f32'] },
    gpuDotF32x4:        { intrinsic: '__builtin_gpu_dot_f32x4', returnType: 'f32', paramTypes: ['Ptr<f32>', 'Ptr<f32>'] },
};

// §14.3.1 で gpu 関数引数・ローカル・戻り値に許される型のホワイトリスト
function isGpuAllowedType(t: string): boolean {
    // 参照型は不可
    if (t.startsWith('&')) return false;
    const scalars = ['i32', 'u32', 'f32', 'i64', 'u64', 'f64', 'boolean', 'void'];
    if (scalars.includes(t)) return true;
    if (t.startsWith('Ptr<') || t.startsWith('Array<')) return true;
    // plain class は名前ベース判定不能なのでチェッカー側で別途検証
    // (ここでは単純名 = ジェネリクスなし) を受け入れる
    if (!t.includes('<') && !t.includes(' ')) return true;
    return false;
}

// §14.3.2 で gpu 関数本体内で禁止される intrinsic 群 (前方一致)
const GPU_FORBIDDEN_INTRINSIC_PREFIXES = [
    '__builtin_malloc', '__builtin_free',
    '__builtin_mem_', '__builtin_zeroinit', '__builtin_sizeof',
    '__builtin_ptr_', '__builtin_str_',
    '__builtin_stdout_', '__builtin_stderr_', '__builtin_stdin_', '__builtin_panic',
    '__builtin_thread_', '__builtin_threadpool_', '__builtin_mutex_', '__builtin_condvar_',
    '__builtin_atomic_',
    '__builtin_gpu_buffer_', '__builtin_gpu_args_', '__builtin_gpu_kernel_',
    '__builtin_gpu_dispatch', '__builtin_gpu_sync', '__builtin_gpu_flush',
    '__builtin_gpu_is_available',
];

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
    inLitCtx:   boolean;  // コンストラクタ引数内ならリテラル許可
    // §14.3.2 検査用: 現在 gpu 関数本体内にいるか (本体内なら §14.4 builtin 呼び出しを許可、
    // 禁止 intrinsic / new / 非 gpu 関数呼び出しを拒否する)。
    inGpuFunc?: { name: string };
}

// ── Checker ───────────────────────────────────────────────────────────────────

export class Checker {
    constructor(private reg: Registry) {}

    private tmpCounter = 0;
    private freshTmp(): string { return `__str_${this.tmpCounter++}`; }

    private makeU32Lit(n: number): IR.NewExpr {
        return { type: 'NewExpr', resolvedType: 'u32', args: [{ type: 'RawLiteral', kind: 'int', value: n }] };
    }

    // §6.6: this を引数として渡すことを禁止する（所有権システム導入で借用チェッカーへ委譲）
    private rejectThisArgs(_args: A.PExpr[]): void {
        // 何もしない（借用チェッカーが安全性を検証する）
    }

    // ファイル全体を検査して IR ノードを返す
    check(file: A.PFile): IR.ASTNode[] {
        const { isMoc } = file;
        const nodes: IR.ASTNode[] = [];

        // Pass 1: 全宣言をレジストリに登録
        for (const decl of file.decls) {
            this.registerDecl(decl, isMoc);
        }

        // Pass 2: 各宣言を検査して IR ノードを出力 (gpu 関数は複数ノードを生成しうる)
        for (const decl of file.decls) {
            const out = this.checkTopDecl(decl, isMoc);
            if (Array.isArray(out)) nodes.push(...out);
            else nodes.push(out);
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
                if (decl.isGpu) {
                    // gpu 関数は内部名 __gpu_kernel_<name> として funcEnv に登録し、
                    // ユーザの名前は GpuKernel 定数として globalEnv に予約する。
                    const internalName = `__gpu_kernel_${decl.name}`;
                    this.reg.funcEnv.set(internalName, {
                        type: 'FunctionDecl', name: internalName, access: decl.access,
                        isMut: false, isGpu: true,
                        workgroupSize: decl.workgroupSize ?? [64, 1, 1],
                        typeParams: [], params,
                        returnType: this.resolveType(decl.returnType, isMoc),
                        body: [],
                    });
                    this.reg.globalEnv.set(decl.name, { type: 'GpuKernel', mut: false });
                } else {
                    this.reg.funcEnv.set(decl.name, {
                        type: 'FunctionDecl', name: decl.name, access: decl.access,
                        isMut: decl.isMut, isGpu: false,
                        typeParams: decl.typeParams, params,
                        returnType: this.resolveType(decl.returnType, isMoc),
                        body: [],
                    });
                }
                break;
            }
            default: break;
        }
    }

    // ── Pass 2: 検査 ─────────────────────────────────────────────────────────

    private checkTopDecl(decl: A.PTopLevelDecl, isMoc: boolean): IR.ASTNode | IR.ASTNode[] {
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
                if (decl.isGpu) return this.checkGpuFunctionDecl(decl, isMoc);
                const fn = this.checkFunctionDecl(decl, isMoc, null);
                this.reg.funcEnv.set(decl.name, fn);
                return fn;
            }

            case 'vardecl': {
                const rt = this.resolveType(decl.type, isMoc);
                const ctx: CheckCtx = {
                    isMoc, locals: new Map(), thisType: null,
                    returnType: 'void', inLitCtx: false,
                };
                const value = this.checkExpr(decl.value, ctx);
                return { type: 'VarDecl', name: decl.name, resolvedType: rt, value };
            }
        }
    }

    // ── gpu 関数宣言 (§14) ─────────────────────────────────────────────────
    // 仕様:
    //   §14.2.2  mocp public は不可 / クラスメソッドの gpu 修飾は不可 (パーサが弾く)
    //   §14.3.1  引数・戻り値・ローカルの型制約
    //   §14.3.2  本体内で禁止される構文・操作
    //   §14.5    コンパイル時検証 (戻り値は void)
    //   §8.3.1   gpu 関数と同名の GpuKernel 定数をグローバルスコープに自動生成
    //
    // 出力 IR:
    //   1) FunctionDecl  name="__gpu_kernel_<name>" isGpu=true workgroupSize=[X,Y,Z]
    //                    (CPU エミュレーションランタイムが直接呼び出す内部関数)
    //   2) VarDecl       name="<name>" resolvedType="GpuKernel"
    //                    value=new GpuKernel(__builtin_gpu_kernel_handle("<name>"))
    private checkGpuFunctionDecl(decl: A.PFunctionDecl, isMoc: boolean): IR.ASTNode[] {
        // §14.2.2 mocp public との組み合わせ禁止
        if (decl.access === 'mocp public') {
            throw new CheckError(`'mocp public gpu' の組み合わせは禁止です`, decl.pos);
        }
        // §14.5 戻り値型は void でなければならない
        const returnType = this.resolveType(decl.returnType, isMoc);
        if (returnType !== 'void') {
            throw new CheckError(`gpu 関数 '${decl.name}' の戻り値型は void でなければなりません (現在: ${returnType})`, decl.pos);
        }
        // §14.3.1 引数型検査
        const params = decl.params.map(p => {
            const rt = this.resolveType(p.type, isMoc);
            if (!this.isGpuTypeAllowed(rt)) {
                throw new CheckError(`gpu 関数 '${decl.name}' の引数 '${p.name}' は型 '${rt}' を取れません (§14.3.1)`, decl.pos);
            }
            return { name: p.name, resolvedType: rt };
        });
        // ジェネリクスは不可 (GPU IR が monomorphic)
        if (decl.typeParams.length > 0) {
            throw new CheckError(`gpu 関数 '${decl.name}' にジェネリクスは指定できません (§14.3.1)`, decl.pos);
        }

        const internalName = `__gpu_kernel_${decl.name}`;
        // 内部関数として登録 (funcEnv に登録すると本体で再帰呼び出しを認識できるが、
        // 仕様 §14.3.2 で再帰禁止なので本体検査後に rejectRecursion で弾く)
        const stub: IR.FunctionDecl = {
            type: 'FunctionDecl', name: internalName, access: decl.access,
            isMut: false, isGpu: true,
            workgroupSize: decl.workgroupSize ?? [64, 1, 1],
            typeParams: [], params, returnType,
            body: [],
        };
        this.reg.funcEnv.set(internalName, stub);
        // ユーザの「vecAdd」名前は GpuKernel 定数として globalEnv に予約
        this.reg.globalEnv.set(decl.name, { type: 'GpuKernel', mut: false });

        // 本体検査
        const locals = new Map<string, { type: string; mut: boolean }>();
        for (const p of params) locals.set(p.name, { type: p.resolvedType, mut: true });
        const ctx: CheckCtx = {
            isMoc, locals, thisType: null, returnType,
            inLitCtx: false,
            inGpuFunc: { name: decl.name },
        };
        const body = this.checkBody(decl.body, ctx);
        stub.body = body;
        // §14.3.2 本体検証 (禁止 intrinsic / new / ローカル型)
        this.validateGpuBody(body, decl.name, decl.pos);

        // GpuKernel 定数 VarDecl を生成
        // value = new GpuKernel(__builtin_gpu_kernel_handle("<name>"))
        const handleCall: IR.Intrinsic = {
            type: 'Intrinsic', name: '__builtin_gpu_kernel_handle', resolvedType: '_m64',
            args: [{ type: 'RawLiteral', kind: 'int', value: this.internKernelName(decl.name) }],
        };
        const kernelVar: IR.VarDecl = {
            type: 'VarDecl', name: decl.name, resolvedType: 'GpuKernel',
            value: {
                type: 'NewExpr', resolvedType: 'GpuKernel',
                args: [handleCall],
            },
        };

        return [stub, kernelVar];
    }

    // gpu カーネル名→数値ハンドルへの簡易インターン (CPU エミュレーション時に文字列ルックアップに変換)
    // 数値は ID 化のための一意整数。実行時には名前テーブルを介して関数を解決する。
    private kernelNames: string[] = [];
    private internKernelName(name: string): number {
        let i = this.kernelNames.indexOf(name);
        if (i < 0) { i = this.kernelNames.length; this.kernelNames.push(name); }
        return i;
    }

    // §14.4 builtin の呼び出しを Intrinsic として lower する。
    // 戻り型がスカラー (i32/u32/f32 等) ならラッパー型の NewExpr で包む。
    // 引数が Ptr<T> の場合、ランタイムは生アドレスを期待するため `.addr` を取り出す。
    private makeGpuBuiltinCall(sig: GpuBuiltinSig, argExprs: A.PExpr[], ctx: CheckCtx): IR.ASTNode {
        // ctx は読まないが将来の拡張に備えて受け取る
        void ctx;
        const args: IR.ASTNode[] = [];
        for (let i = 0; i < argExprs.length; i++) {
            let a = this.checkExpr(argExprs[i], ctx);
            const expected = sig.paramTypes[i];
            // 引数型が Ptr<T> の場合、生アドレス (_m32) を渡す
            if (expected && expected.startsWith('Ptr<')) {
                a = { type: 'MemberAccess', resolvedType: '_m32', receiver: a, member: 'addr' };
            } else if (expected) {
                // ラッパー型の bits フィールドを取り出して生ビット値にする
                a = { type: 'MemberAccess', resolvedType: '_m32', receiver: a, member: 'bits' };
            }
            args.push(a);
        }
        const intr: IR.Intrinsic = {
            type: 'Intrinsic', name: sig.intrinsic,
            resolvedType: sig.returnType === 'void' ? 'void'
                          : sig.returnType === 'boolean' ? '_m32'
                          : sig.returnType.startsWith('i64') || sig.returnType.startsWith('u64') || sig.returnType.startsWith('f64') ? '_m64'
                          : '_m32',
            args,
        };
        if (sig.returnType === 'void') return intr;
        // スカラー戻り値はラッパーで包む
        return {
            type: 'NewExpr', resolvedType: sig.returnType, args: [intr],
        };
    }

    // §14.3.1: gpu 関数の引数/ローカル/戻り値で許される型か
    private isGpuTypeAllowed(t: string): boolean {
        if (t.startsWith('&')) return false;
        const scalars = ['i32', 'u32', 'f32', 'i64', 'u64', 'f64', 'boolean', 'void'];
        if (scalars.includes(t)) return true;
        // ジェネリクス: Ptr<T> / Array<T> のみ許可
        if (t.startsWith('Ptr<') || t.startsWith('Array<')) {
            // 内側の T も再帰的に検査
            const inner = t.slice(t.indexOf('<') + 1, t.lastIndexOf('>'));
            // ネストした Ptr<Ptr<...>> は GPU IR で表現できないので拒否
            if (inner.startsWith('Ptr<') || inner.startsWith('Array<')) return false;
            return this.isGpuTypeAllowed(inner);
        }
        // GpuBuffer / Result / Option / string は禁止 (string == Array<u32> はエイリアス展開で Array に化けるので OK)
        if (t === 'GpuBuffer' || t === 'GpuArgs' || t === 'GpuKernel' || t === 'string') return false;
        if (t.startsWith('Result<') || t.startsWith('Option<')) return false;
        // 他のジェネリクス型は disallow
        if (t.includes('<')) return false;
        // plain class はクラス定義を見て plain (フィールドのみ) であることを別途検査するべきだが、
        // 現バージョンではラッパー型 (i32 等の単一 _mXX フィールド) も含めて受け入れる
        return true;
    }

    // ── クラス宣言 ────────────────────────────────────────────────────────────

    // gpu 関数本体の IR を後方検査し、§14.3.2 で禁止される intrinsic / new を拒否する。
    private validateGpuBody(body: IR.ASTNode[], kernelName: string, pos: A.Pos): void {
        const walk = (n: IR.ASTNode): void => {
            switch (n.type) {
                case 'Intrinsic': {
                    for (const pfx of GPU_FORBIDDEN_INTRINSIC_PREFIXES) {
                        if (n.name.startsWith(pfx)) {
                            // ただし __builtin_gpu_thread_* / __builtin_gpu_barrier / __builtin_gpu_atomic_* /
                            // __builtin_gpu_fma / __builtin_gpu_dot_f32x4 は §14.4 の許可済み命令なので除外
                            if (n.name.startsWith('__builtin_gpu_thread_') ||
                                n.name.startsWith('__builtin_gpu_barrier') ||
                                n.name.startsWith('__builtin_gpu_storage_barrier') ||
                                n.name.startsWith('__builtin_gpu_atomic_') ||
                                n.name === '__builtin_gpu_fma' ||
                                n.name === '__builtin_gpu_dot_f32x4') {
                                break;
                            }
                            throw new CheckError(`gpu 関数 '${kernelName}' 内で禁止された組み込み '${n.name}' が使われました (§14.3.2)`, pos);
                        }
                    }
                    for (const a of n.args) walk(a);
                    break;
                }
                case 'NewExpr': {
                    // §14.3.2 動的メモリ確保禁止。例外: 単一 _mXX フィールドを持つラッパー型は値型なので許可
                    const baseName = n.resolvedType.includes('<')
                        ? n.resolvedType.slice(0, n.resolvedType.indexOf('<'))
                        : n.resolvedType;
                    const cls = this.reg.classEnv.get(baseName);
                    if (!cls) {
                        // クラス不明: 念のため許可 (string 等)
                    } else {
                        const isWrapper = cls.members.length === 1 &&
                            ['_m8', '_m16', '_m32', '_m64'].includes(cls.members[0].resolvedType);
                        if (!isWrapper) {
                            throw new CheckError(`gpu 関数 '${kernelName}' 内で 'new ${baseName}' は使用できません (§14.3.2: 動的メモリ確保禁止)`, pos);
                        }
                    }
                    for (const a of n.args) walk(a);
                    // elements は廃止済み。strlit は preStmts 経由で展開される前にチェックされる。
                    break;
                }
                case 'MethodCall':
                    walk(n.receiver);
                    for (const a of n.args) walk(a);
                    break;
                case 'MemberAccess': walk(n.receiver); break;
                case 'BorrowExpr':   walk(n.expr); break;
                case 'Assign':       walk(n.target); walk(n.value); break;
                case 'VarDecl': {
                    // §14.3.1 ローカル変数の型検査
                    if (!this.isGpuTypeAllowed(n.resolvedType)) {
                        throw new CheckError(`gpu 関数 '${kernelName}' 内のローカル '${n.name}' は型 '${n.resolvedType}' を取れません (§14.3.1)`, pos);
                    }
                    walk(n.value);
                    break;
                }
                case 'IfStmt':
                    walk(n.cond);
                    for (const s of n.body) walk(s);
                    if (n.else) walk(n.else);
                    break;
                case 'ElseStmt':
                    for (const s of n.body) walk(s);
                    break;
                case 'WhileStmt':
                case 'ForStmt':
                    walk((n as any).cond);
                    if ((n as any).init) walk((n as any).init);
                    if ((n as any).update) walk((n as any).update);
                    for (const s of (n as any).body) walk(s);
                    break;
                case 'BlockStmt':
                    for (const s of n.body) walk(s);
                    break;
                case 'ReturnStmt':
                    if (n.value) walk(n.value);
                    break;
                default: break;
            }
        };
        for (const stmt of body) walk(stmt);
    }

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
            // §14.2.2 クラスメソッドへの gpu 修飾は禁止
            if (m.isGpu) {
                throw new CheckError(`クラスメソッドに 'gpu' 修飾子は付与できません (§14.2.2)`, m.pos);
            }
            const params = m.params.map(p => ({
                name: p.name, resolvedType: this.resolveType(p.type, isMoc),
            }));
            methods.push({
                type: 'FunctionDecl', name: m.name, access: m.access,
                isMut: m.isMut, isGpu: m.isGpu,
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
            const actualThisType = m.name === 'constructor' ? `&mut ${thisType}` : (m.isMut ? `&mut ${thisType}` : `&${thisType}`);
            const ctx: CheckCtx = {
                isMoc, locals, thisType: actualThisType, returnType: stub.returnType, inLitCtx: false,
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
            isMut: decl.isMut, isGpu: decl.isGpu,
            typeParams: decl.typeParams, params, returnType, body,
        };
    }

    // ── ブロック ──────────────────────────────────────────────────────────────

    private checkBody(stmts: A.PStmt[], ctx: CheckCtx): IR.ASTNode[] {
        const nodes: IR.ASTNode[] = [];
        const scopedCtx: CheckCtx = { ...ctx, locals: new Map(ctx.locals) };
        for (const stmt of stmts) {
            const pre: IR.ASTNode[] = [];
            const node = this.checkStmt(stmt, scopedCtx, pre);
            nodes.push(...pre, node);
        }
        return nodes;
    }

    // ── 文 ────────────────────────────────────────────────────────────────────

    private checkStmt(stmt: A.PStmt, ctx: CheckCtx, pre: IR.ASTNode[] = []): IR.ASTNode {
        switch (stmt.kind) {
            case 'vardecl': {
                if (ctx.locals.has(stmt.name)) {
                    throw new CheckError(`'${stmt.name}' はシャドーイングできません`, stmt.pos);
                }
                const rt = this.resolveType(stmt.type, ctx.isMoc);
                const value = this.checkExpr(stmt.value, ctx, pre);
                ctx.locals.set(stmt.name, { type: rt, mut: stmt.mut });
                return { type: 'VarDecl', name: stmt.name, resolvedType: rt, value };
            }

            case 'assign': {
                if (stmt.target.kind === 'ident') {
                    const local = ctx.locals.get(stmt.target.name);
                    if (local && !local.mut) {
                        throw new CheckError(`const '${stmt.target.name}' には代入できません`, stmt.pos);
                    }
                }
                if (stmt.target.kind === 'index') {
                    const obj = this.checkExpr((stmt.target as A.PIndexExpr).obj, ctx, pre);
                    const idx = this.checkExpr((stmt.target as A.PIndexExpr).index, ctx, pre);
                    const val = this.checkExpr(stmt.value, ctx, pre);
                    return this.makeCall(obj, 'operator_set[]', [idx, val], resolvedType(obj));
                }
                return { type: 'Assign', target: this.checkExpr(stmt.target, ctx, pre), value: this.checkExpr(stmt.value, ctx, pre) };
            }

            case 'exprstmt':
                return this.checkExpr(stmt.expr, ctx, pre);

            case 'if': {
                const cond: IR.Intrinsic = {
                    type: 'Intrinsic', name: '__builtin_if', resolvedType: '_m32',
                    args: [this.checkExpr(stmt.cond, ctx, pre)],
                };
                const body = this.checkBody(stmt.body, ctx);
                let elseNode: IR.IfStmt | IR.ElseStmt | null = null;
                if (stmt.elseIf) {
                    elseNode = this.checkStmt(stmt.elseIf, ctx, pre) as IR.IfStmt;
                } else if (stmt.elseBody) {
                    elseNode = { type: 'ElseStmt', body: this.checkBody(stmt.elseBody, ctx) };
                }
                return { type: 'IfStmt', cond, body, else: elseNode };
            }

            case 'while': {
                const cond: IR.Intrinsic = {
                    type: 'Intrinsic', name: '__builtin_while', resolvedType: '_m32',
                    args: [this.checkExpr(stmt.cond, ctx, pre)],
                };
                return { type: 'WhileStmt', cond, body: this.checkBody(stmt.body, ctx) };
            }

            case 'for': {
                const forCtx: CheckCtx = { ...ctx, locals: new Map(ctx.locals) };

                const initRt = this.resolveType(stmt.init.type, ctx.isMoc);
                const initValue = this.checkExpr(stmt.init.value, forCtx, pre);
                const init: IR.VarDecl = { type: 'VarDecl', name: stmt.init.name, resolvedType: initRt, value: initValue };
                forCtx.locals.set(stmt.init.name, { type: initRt, mut: stmt.init.mut });

                const cond: IR.Intrinsic = {
                    type: 'Intrinsic', name: '__builtin_if', resolvedType: '_m32',
                    args: [this.checkExpr(stmt.cond, forCtx, pre)],
                };

                let update: IR.ASTNode;
                if (stmt.update.kind === 'assign') {
                    const upd = stmt.update as A.PAssignStmt;
                    if (upd.target.kind === 'index') {
                        const obj = this.checkExpr((upd.target as A.PIndexExpr).obj, forCtx, pre);
                        const idx = this.checkExpr((upd.target as A.PIndexExpr).index, forCtx, pre);
                        const val = this.checkExpr(upd.value, forCtx, pre);
                        const objType = resolvedType(obj);
                        update = this.makeCall(obj, 'operator_set[]', [idx, val], objType);
                    } else {
                        update = { type: 'Assign', target: this.checkExpr(upd.target, forCtx, pre), value: this.checkExpr(upd.value, forCtx, pre) };
                    }
                } else {
                    update = this.checkExpr((stmt.update as A.PExprStmt).expr, forCtx, pre);
                }

                return { type: 'ForStmt', init, cond, update, body: this.checkBody(stmt.body, forCtx) };
            }

            case 'return': {
                if (stmt.value === null) return { type: 'ReturnStmt', value: null };
                return { type: 'ReturnStmt', value: this.checkExpr(stmt.value, ctx, pre) };
            }

            case 'break':
                return { type: 'BreakStmt' };

            case 'block':
                return { type: 'BlockStmt', body: this.checkBody(stmt.body, ctx) };
        }
    }

    // ── 式 ────────────────────────────────────────────────────────────────────

    private checkExpr(expr: A.PExpr, ctx: CheckCtx, pre: IR.ASTNode[] = []): IR.ASTNode {
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
                // 文字列リテラル → new Array<u32>(n) + operator_set[] 連鎖 (IR §6 / corelib §7.2)
                const tmp = this.freshTmp();
                const n = expr.value.length;
                // VarDecl: let __str_N: Array<u32> = new Array<u32>(new u32(n))
                const arrInit: IR.NewExpr = { type: 'NewExpr', resolvedType: 'Array<u32>', args: [this.makeU32Lit(n)] };
                pre.push({ type: 'VarDecl', name: tmp, resolvedType: 'Array<u32>', value: arrInit });
                ctx.locals.set(tmp, { type: 'Array<u32>', mut: true });
                // operator_set[] 呼び出し列
                for (let i = 0; i < n; i++) {
                    const setCall: IR.MethodCall = {
                        type: 'MethodCall', resolvedType: 'void',
                        receiver: { type: 'Identifier', name: tmp, resolvedType: 'Array<u32>' },
                        method: 'operator_set[]',
                        args: [
                            this.makeU32Lit(i),
                            { type: 'NewExpr', resolvedType: 'u32', args: [{ type: 'RawLiteral', kind: 'char', value: expr.value.charCodeAt(i) }] },
                        ],
                    };
                    pre.push(setCall);
                }
                return { type: 'Identifier', name: tmp, resolvedType: 'Array<u32>' };
            }

            case 'new': {
                const rt = this.resolveType(expr.type, ctx.isMoc);
                this.rejectThisArgs(expr.args);
                const litCtx: CheckCtx = { ...ctx, inLitCtx: true };
                const args = expr.args.map(a => this.checkExpr(a, litCtx, pre));
                return { type: 'NewExpr', resolvedType: rt, args };
            }

            case 'borrow': {
                const operand = this.checkExpr(expr.expr, ctx, pre);
                const rt = resolvedType(operand);
                const prefix = expr.isMut ? '&mut ' : '&';
                return {
                    type: 'BorrowExpr',
                    isMut: expr.isMut,
                    expr: operand,
                    resolvedType: `${prefix}${rt}`
                };
            }

            case 'unary': {
                const operand = this.checkExpr(expr.expr, ctx, pre);
                const recvType = resolvedType(operand);
                if (expr.op === '!') {
                    return this.makeCall(operand, 'operatorNot', [], recvType);
                }
                if (expr.op === '-') {
                    // リテラルコンテキスト内の負数リテラル: RawLiteral を直接否定
                    if (operand.type === 'RawLiteral') {
                        return { type: 'RawLiteral', kind: operand.kind, value: -(operand as any).value };
                    }
                    // 単項マイナスは negate() メソッドへ脱糖（§6.5）。
                    // negate を持たない型（u32/u64 等）はここでコンパイルエラーにする
                    const baseName = recvType.replace(/^&mut\s+|^&/, '').replace(/<.*>$/, '');
                    const cls = this.reg.classEnv.get(baseName);
                    if (!cls || !cls.methods.some(m => m.name === 'negate')) {
                        throw new CheckError(`型 '${recvType}' は単項マイナス（negate メソッド）に対応していません`, expr.pos);
                    }
                    return this.makeCall(operand, 'negate', [], recvType);
                }
                throw new CheckError(`未知の単項演算子 '${expr.op}'`, expr.pos);
            }

            case 'bin': {
                // <= と >= は脱糖
                if (expr.op === '<=' || expr.op === '>=') {
                    const cmpOp = expr.op === '<=' ? 'operator<' : 'operator>';
                    const l1 = this.checkExpr(expr.left, ctx, pre);
                    const r1 = this.checkExpr(expr.right, ctx, pre);
                    const l2 = this.checkExpr(expr.left, ctx, pre);
                    const r2 = this.checkExpr(expr.right, ctx, pre);
                    const lt = resolvedType(l1);
                    const cmpNode = this.makeCall(l1, cmpOp, [r1], lt);
                    const eqNode  = this.makeCall(l2, 'operator==', [r2], lt);
                    return this.makeCall(cmpNode, 'operator||', [eqNode], resolvedType(cmpNode));
                }
                // != は脱糖
                if (expr.op === '!=') {
                    const l = this.checkExpr(expr.left, ctx, pre);
                    const r = this.checkExpr(expr.right, ctx, pre);
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
                const left  = this.checkExpr(expr.left, ctx, pre);
                const right = this.checkExpr(expr.right, ctx, pre);
                return this.makeCall(left, method, [right], resolvedType(left));
            }

            case 'call': {
                // __builtin_* → Intrinsic ノード
                if (expr.name.startsWith('__builtin_')) {
                    if (!ctx.isMoc) {
                        throw new CheckError(`組み込み関数は .moc ファイル内のみ使用可能`, expr.pos);
                    }
                    const rt = BUILTIN_RET[expr.name] ?? '_m32';
                    this.rejectThisArgs(expr.args);
                    const args = expr.args.map(a => this.checkExpr(a, ctx, pre));
                    const node: IR.Intrinsic = { type: 'Intrinsic', name: expr.name, resolvedType: rt, args };
                    if (expr.name === '__builtin_sizeof' && expr.typeArgs.length > 0) {
                        node.targetType = this.resolveType(expr.typeArgs[0], ctx.isMoc);
                    }
                    return node;
                }
                // §14.4 GPU builtin: gpu 関数本体内のみで呼べる組み込み
                const gpuSig = GPU_BUILTINS[expr.name];
                if (gpuSig) {
                    if (!ctx.inGpuFunc) {
                        throw new CheckError(`'${expr.name}' は gpu 関数本体内でのみ呼び出し可能 (§14.4)`, expr.pos);
                    }
                    return this.makeGpuBuiltinCall(gpuSig, expr.args, ctx);
                }
                // トップレベル関数呼び出し
                let fn = this.reg.funcEnv.get(expr.name);
                // gpu 関数内から自分自身や他の gpu 関数を呼ぼうとした場合は
                // 内部名 (__gpu_kernel_*) で検索する。globalEnv 経由のエラー判定の前に行う。
                if (!fn && ctx.inGpuFunc) {
                    fn = this.reg.funcEnv.get(`__gpu_kernel_${expr.name}`);
                }
                if (!fn) {
                    // ユーザの gpu カーネル名は globalEnv に GpuKernel として登録される。
                    // 直接呼び出し (vecAdd(...)) は §14.3.2 / §14.2 違反
                    const g = this.reg.globalEnv.get(expr.name);
                    if (g && g.type === 'GpuKernel') {
                        throw new CheckError(`gpu 関数 '${expr.name}' を CPU から直接呼ぶことはできません。gpuDispatch() を使用してください (§14.3.2)`, expr.pos);
                    }
                    throw new CheckError(`未知の関数 '${expr.name}'`, expr.pos);
                }
                // gpu 関数本体内: 非 gpu 関数の呼び出しは禁止 (§14.3.2)
                if (ctx.inGpuFunc && !fn.isGpu) {
                    throw new CheckError(`gpu 関数内から非 gpu 関数 '${expr.name}' を呼び出せません (§14.3.2)`, expr.pos);
                }
                // §14.3.2 / GPU IR §6.7: gpu 関数間呼び出しはフロントエンドがインライン展開する MUST。
                // 本実装ではインライン展開未対応なので gpu→gpu 呼び出しを拒否する (再帰禁止も併せて満たす)。
                if (ctx.inGpuFunc && fn.isGpu) {
                    if (`__gpu_kernel_${ctx.inGpuFunc.name}` === fn.name) {
                        throw new CheckError(`gpu 関数 '${ctx.inGpuFunc.name}' の再帰呼び出しは禁止です (§14.3.2)`, expr.pos);
                    }
                    throw new CheckError(`gpu 関数間呼び出し ('${expr.name}') は現バージョンでは未対応です (§14.3.2 + GPU IR §6.7 が MUST とするフロントエンドインライン展開が本実装には未実装)`, expr.pos);
                }
                const subst = new Map<string, string>();
                fn.typeParams.forEach((tp, i) => {
                    if (expr.typeArgs[i]) subst.set(tp, this.resolveType(expr.typeArgs[i], ctx.isMoc));
                });
                const rt = applySubst(fn.returnType, subst);
                this.rejectThisArgs(expr.args);
                const args = expr.args.map(a => this.checkExpr(a, ctx, pre));
                return {
                    type: 'MethodCall', resolvedType: rt,
                    receiver: { type: 'Identifier', name: expr.name, resolvedType: rt },
                    method: expr.name, args,
                };
            }

            case 'methodcall': {
                if (expr.obj.kind === 'ident' && this.reg.namespaces.has(expr.obj.name)) {
                    const gpuSig = GPU_BUILTINS[expr.method];
                    if (gpuSig) {
                        if (!ctx.inGpuFunc) {
                            throw new CheckError(`'${expr.method}' は gpu 関数本体内でのみ呼び出し可能 (§14.4)`, expr.pos);
                        }
                        return this.makeGpuBuiltinCall(gpuSig, expr.args, ctx);
                    }
                    const fn = this.reg.funcEnv.get(expr.method);
                    if (!fn) {
                        const g = this.reg.globalEnv.get(expr.method);
                        if (g && g.type === 'GpuKernel') {
                            throw new CheckError(`gpu 関数 '${expr.obj.name}.${expr.method}' を CPU から直接呼ぶことはできません (§14.3.2)`, expr.pos);
                        }
                        throw new CheckError(`未知の関数 '${expr.obj.name}.${expr.method}'`, expr.pos);
                    }
                    if (ctx.inGpuFunc && !fn.isGpu) {
                        throw new CheckError(`gpu 関数内から非 gpu 関数 '${expr.obj.name}.${expr.method}' を呼び出せません (§14.3.2)`, expr.pos);
                    }
                    if (ctx.inGpuFunc && fn.isGpu) {
                        throw new CheckError(`gpu 関数間呼び出し ('${expr.obj.name}.${expr.method}') は現バージョンでは未対応です (§14.3.2 + GPU IR §6.7)`, expr.pos);
                    }
                    const subst = new Map<string, string>();
                    fn.typeParams.forEach((tp, i) => {
                        if (expr.typeArgs[i]) subst.set(tp, this.resolveType(expr.typeArgs[i], ctx.isMoc));
                    });
                    const rt = applySubst(fn.returnType, subst);
                    this.rejectThisArgs(expr.args);
                    const args = expr.args.map(a => this.checkExpr(a, ctx, pre));
                    const qualifiedName = `${expr.obj.name}.${expr.method}`;
                    return {
                        type: 'MethodCall', resolvedType: rt,
                        receiver: { type: 'Identifier', name: qualifiedName, resolvedType: rt },
                        method: qualifiedName, args,
                    };
                }
                const obj = this.checkExpr(expr.obj, ctx, pre);
                const objType = resolvedType(obj);
                this.rejectThisArgs(expr.args);
                const args = expr.args.map(a => this.checkExpr(a, ctx, pre));
                return this.makeCall(obj, expr.method, args, objType);
            }

            case 'index': {
                const obj = this.checkExpr(expr.obj, ctx, pre);
                const idx = this.checkExpr(expr.index, ctx, pre);
                return this.makeCall(obj, 'operator[]', [idx], resolvedType(obj));
            }

            case 'member': {
                const obj = this.checkExpr(expr.obj, ctx, pre);
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
        
        let name = simpleName;
        if (pt.args.length === 0) {
            // エイリアス展開（連鎖対応）
            const seen = new Set<string>();
            while (this.reg.typeAliases.has(name) && !seen.has(name)) {
                seen.add(name);
                name = this.reg.typeAliases.get(name)!;
            }
        } else {
            // ジェネリクス型
            const resolvedArgs = pt.args.map(a => this.resolveType(a, isMoc));
            name = `${simpleName}<${resolvedArgs.join(',')}>`;
        }

        if (pt.isRef) {
            return pt.isMut ? `&mut ${name}` : `&${name}`;
        }
        return name;
    }

    // ── メソッド戻り型取得 ────────────────────────────────────────────────────

    private methodReturnType(receiverType: string, methodName: string): string {
        const cleanType = receiverType.replace(/^&mut\s+|^&/, '');
        const lt = cleanType.indexOf('<');
        const baseName = lt === -1 ? cleanType : cleanType.slice(0, lt);
        const cls = this.reg.classEnv.get(baseName);
        if (!cls) return 'void';

        // 型パラメータ代入マップを構築
        const subst = new Map<string, string>();
        if (lt !== -1 && cls.typeParams.length > 0) {
            const inner = cleanType.slice(lt + 1, cleanType.lastIndexOf('>'));
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
        const cleanType = receiverType.replace(/^&mut\s+|^&/, '');
        const lt = cleanType.indexOf('<');
        const baseName = lt === -1 ? cleanType : cleanType.slice(0, lt);
        const cls = this.reg.classEnv.get(baseName);
        if (!cls) return '_m32';

        const subst = new Map<string, string>();
        if (lt !== -1 && cls.typeParams.length > 0) {
            const inner = cleanType.slice(lt + 1, cleanType.lastIndexOf('>'));
            splitTypeArgs(inner).forEach((arg, i) => {
                if (cls.typeParams[i]) subst.set(cls.typeParams[i], arg);
            });
        }

        const field = cls.members.find(f => f.name === fieldName);
        if (!field) return '_m32';
        return applySubst(field.resolvedType, subst);
    }

    // ── MethodCall ノード生成ヘルパー ─────────────────────────────────────────

    private makeCall(receiver: IR.ASTNode, method: string, args: IR.ASTNode[], receiverType: string, isNamespaceFn: boolean = false): IR.MethodCall {
        const rt = this.methodReturnType(receiverType, method);
        if (isNamespaceFn) {
            return { type: 'MethodCall', resolvedType: rt, receiver, method, args };
        }

        const isAlreadyRef = receiverType.startsWith('&');
        const cleanType = receiverType.replace(/^&mut\s+|^&/, '');
        const lt = cleanType.indexOf('<');
        const baseName = lt === -1 ? cleanType : cleanType.slice(0, lt);
        const cls = this.reg.classEnv.get(baseName);

        let finalReceiver = receiver;
        if (cls && !isAlreadyRef) {
            // §3.3 自動レシーバーバインド: 所有権値 (T) のみ自動で &/&mut を付与する。
            // 既に参照型 (&T / &mut T) の値は再ラップしない（&&T を防ぐ）。
            const m = cls.methods.find(m => m.name === method);
            if (m) {
                const prefix = m.isMut ? '&mut ' : '&';
                finalReceiver = {
                    type: 'BorrowExpr',
                    isMut: m.isMut,
                    expr: receiver,
                    resolvedType: `${prefix}${cleanType}`
                };
            }
        }

        return {
            type: 'MethodCall',
            resolvedType: rt,
            receiver: finalReceiver, method, args,
        };
    }
}
