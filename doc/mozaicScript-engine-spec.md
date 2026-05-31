# 📄 mozaicScript 実行エンジン仕様書 (Interpreter Engine Specification)

本仕様書は mozaicScript 中間表現仕様書が定義するJSON形式のASTを直接実行するインタープリタエンジンの仕様を定義する。実装言語はTypeScriptとする。

---

## 1. 概要・設計方針

- JSON形式のASTを入力として受け取り、直接実行する
- ネイティブコードの生成は行わない
- 主な用途はデバッグ・動作確認・プロトタイピング
- mozaicScriptの型システムはフロントエンドが保証済みとして信頼する（エンジン側で型チェックは行わない）

> **注意:** 所有権・借用システムに関連する拡張（ゼロコスト借用の評価や自動挿入された解放命令の処理）の詳細については、「[mozaicScript 所有権・借用システム拡張追加仕様書](mozaicScript-ownership-spec.md)」を参照すること。

---

## 2. ディレクトリ構成

```
interpreter/
├── index.ts         // エントリーポイント
├── types.ts         // ASTノードのTypeScript型定義
├── values.ts        // ランタイム値の型定義
├── environment.ts   // スコープ・変数環境の管理
├── evaluator.ts     // ノード評価のメインロジック
└── builtins.ts      // __builtin_* 命令の実装
```

---

## 3. ASTノードの型定義 (`types.ts`)

中間表現仕様書のノード一覧に対応するTypeScriptの型を定義する。

```typescript
export type AccessModifier = "public" | "private" | "mocp public";

export type ASTNode =
    | ImportDecl
    | TypeAliasDecl
    | ClassDecl
    | FunctionDecl
    | VarDecl
    | MethodCall
    | NewExpr
    | Assign
    | Identifier
    | Intrinsic
    | IfStmt
    | ElseStmt
    | WhileStmt
    | ForStmt
    | ReturnStmt
    | BreakStmt
    | RawLiteral
    | MemberAccess
    | BlockStmt
    | BorrowExpr;

export interface ImportDecl {
    type: "ImportDecl";
    path: string;
    namespace: string | null;
}

export interface TypeAliasDecl {
    type: "TypeAliasDecl";
    name: string;
    resolvedType: string;
}

export interface ClassDecl {
    type: "ClassDecl";
    name: string;
    access: AccessModifier;
    typeParams: string[];
    members: FieldDecl[];
    methods: FunctionDecl[];
}

export interface FieldDecl {
    type: "FieldDecl";
    name: string;
    access: AccessModifier;
    resolvedType: string;
}

export interface FunctionDecl {
    type: "FunctionDecl";
    name: string;
    access: AccessModifier;
    isMut: boolean;          // 所有権・借用システム拡張§5.1 で追加。mut 修飾子の有無
    typeParams: string[];
    params: { name: string; resolvedType: string }[];
    returnType: string;
    body: ASTNode[];
}

export interface VarDecl {
    type: "VarDecl";
    name: string;
    resolvedType: string;
    value: ASTNode;
}

export interface MethodCall {
    type: "MethodCall";
    resolvedType: string;
    receiver: ASTNode;
    method: string;
    args: ASTNode[];
}

export interface NewExpr {
    type: "NewExpr";
    resolvedType: string;
    args: ASTNode[];
    // 文字列リテラルは IR 仕様§6 に従いフロントエンドが operator_set[] 連鎖に展開済みのため、
    // 専用の elements フィールドは存在しない。
}

export interface Assign {
    type: "Assign";
    target: ASTNode;
    value: ASTNode;
}

export interface Identifier {
    type: "Identifier";
    name: string;
    resolvedType: string;
}

export interface Intrinsic {
    type: "Intrinsic";
    name: string;
    resolvedType: string;
    targetType?: string; // __builtin_sizeof の場合のみ使用
    args: ASTNode[];
}

export interface MemberAccess {
    type: "MemberAccess";
    resolvedType: string;
    receiver: ASTNode;
    member: string;
}

// 所有権・借用システム拡張§5.2 で導入された借用式ノード。
// `&a` / `&mut a` の AST 表現。エンジンは式評価でターゲットの ObjectValue 参照を
// そのまま返す（ゼロコスト借用）。
export interface BorrowExpr {
    type: "BorrowExpr";
    isMut: boolean;
    expr: ASTNode;
    resolvedType: string;
}

export interface IfStmt {
    type: "IfStmt";
    cond: ASTNode;
    body: ASTNode[];
    else: IfStmt | ElseStmt | null;
}

export interface ElseStmt {
    type: "ElseStmt";
    body: ASTNode[];
}

export interface WhileStmt {
    type: "WhileStmt";
    cond: ASTNode;
    body: ASTNode[];
}

export interface ForStmt {
    type: "ForStmt";
    init: ASTNode;
    cond: ASTNode;
    update: ASTNode;
    body: ASTNode[];
}

export interface ReturnStmt {
    type: "ReturnStmt";
    value: ASTNode | null;
}

export interface BreakStmt {
    type: "BreakStmt";
}

export interface RawLiteral {
    type: "RawLiteral";
    kind: "int" | "float" | "char";
    value: number;
}

// 並行プリミティブ（スレッド・ミューテックス・条件変数・アトミック）は
// 専用ノードを持たず、すべて Intrinsic（`__builtin_*`）として表現される。
// IR 仕様書「並行プリミティブ（IR ノードなし）」を参照。

export interface MozaicScriptAST {
    mozaicScript: string;
    nodes: ASTNode[];
}
```

---

## 4. ランタイム値の型定義 (`values.ts`)

エンジン内部でのランタイム値の表現を定義する。

```typescript
// ランタイム値の種別
export type RuntimeValue =
    | PrimitiveValue
    | ObjectValue
    | VoidValue;

// _m32 / _m64 相当のプリミティブ値
export interface PrimitiveValue {
    kind: "primitive";
    value: number; // JavaScriptのnumberで表現
}

// クラスのインスタンス
export interface ObjectValue {
    kind: "object";
    className: string;              // クラス名（例："i32", "Array"）
    fields: Record<string, RuntimeValue>; // フィールド名 → 値（Map より高速な plain object）
    classDef: ClassDecl;            // クラス定義への参照
}

// void
export interface VoidValue {
    kind: "void";
}

// ランタイム値のファクトリ関数
export const primitive = (value: number): PrimitiveValue => ({
    kind: "primitive",
    value,
});

// voidValue はシングルトンで返す（毎回生成しない）
const _VOID: VoidValue = { kind: "void" };
export const voidValue = (): VoidValue => _VOID;
```

---

## 5. スコープ・環境の管理 (`environment.ts`)

変数のスコープをチェーン構造で管理する。

```typescript
import { RuntimeValue } from "./values";

export class Environment {
    private store: Record<string, RuntimeValue>;  // Object.create(null) でプロトタイプなし
    private parent: Environment | null;

    constructor(parent: Environment | null = null) {
        this.store = Object.create(null); // プロトタイプなし → 純粋なキー/値ストア
        this.parent = parent;
    }

    // 変数の取得（親スコープを再帰的に探索）
    get(name: string): RuntimeValue {
        const v = this.store[name];
        if (v !== undefined) return v;
        if (this.parent !== null) return this.parent.get(name);
        throw new Error(`Undefined variable: ${name}`);
    }

    // 変数の定義（現在のスコープに追加）
    // 重複チェックはフロントエンドの責務（エンジン側では行わない）
    define(name: string, value: RuntimeValue): void {
        this.store[name] = value;
    }

    // 変数の再代入（定義済みのスコープを反復探索して更新）
    assign(name: string, value: RuntimeValue): void {
        let env: Environment = this;
        while (true) {
            if (env.store[name] !== undefined) {
                env.store[name] = value;
                return;
            }
            if (env.parent === null) throw new Error(`Undefined variable: ${name}`);
            env = env.parent;
        }
    }

    // 子スコープを生成
    extend(): Environment {
        return new Environment(this);
    }
}
```

---

## 6. 組み込み命令の実装 (`builtins.ts`)

`__builtin_*` 命令をTypeScriptの関数として実装する。

```typescript
import { RuntimeValue, primitive, voidValue } from "./values";

type BuiltinFn = (args: RuntimeValue[]) => RuntimeValue;

// i64/u64 の演算は BigInt で行い、number で保持する（インタープリタ用近似）
function toI64(n: number): bigint { return BigInt.asIntN(64, BigInt(Math.trunc(n))); }
function toU64(n: number): bigint { return BigInt.asUintN(64, BigInt(Math.trunc(n))); }
function n64(b: bigint): number   { return Number(b); }
function v(x: RuntimeValue): number { return (x as any).value; }

// __builtin_* 命令のマップ（Map より高速な plain object）
export const builtins: Record<string, BuiltinFn> = Object.fromEntries([

    // ── i32 算術 ─────────────────────────────────────────────────────────────
    ["__builtin_i32_add", ([a, b]) => primitive((v(a) + v(b)) | 0)],
    ["__builtin_i32_sub", ([a, b]) => primitive((v(a) - v(b)) | 0)],
    ["__builtin_i32_mul", ([a, b]) => primitive(Math.imul(v(a), v(b)))],
    ["__builtin_i32_div", ([a, b]) => primitive((v(a) / v(b)) | 0)],
    ["__builtin_i32_mod", ([a, b]) => primitive((v(a) % v(b)) | 0)],
    ["__builtin_i32_eq",  ([a, b]) => primitive(v(a) === v(b) ? 1 : 0)],
    ["__builtin_i32_lt",  ([a, b]) => primitive(v(a) < v(b) ? 1 : 0)],
    ["__builtin_i32_gt",  ([a, b]) => primitive(v(a) > v(b) ? 1 : 0)],
    ["__builtin_i32_neg", ([a])    => primitive((-v(a)) | 0)],

    // ── u32 算術 ─────────────────────────────────────────────────────────────
    ["__builtin_u32_add", ([a, b]) => primitive((v(a) + v(b)) >>> 0)],
    ["__builtin_u32_sub", ([a, b]) => primitive((v(a) - v(b)) >>> 0)],
    ["__builtin_u32_mul", ([a, b]) => primitive(Math.imul(v(a), v(b)) >>> 0)],
    ["__builtin_u32_div", ([a, b]) => primitive((v(a) >>> 0) / (v(b) >>> 0) >>> 0)],
    ["__builtin_u32_mod", ([a, b]) => primitive((v(a) >>> 0) % (v(b) >>> 0) >>> 0)],
    ["__builtin_u32_eq",  ([a, b]) => primitive(v(a) === v(b) ? 1 : 0)],
    ["__builtin_u32_lt",  ([a, b]) => primitive((v(a) >>> 0) < (v(b) >>> 0) ? 1 : 0)],
    ["__builtin_u32_gt",  ([a, b]) => primitive((v(a) >>> 0) > (v(b) >>> 0) ? 1 : 0)],

    // ── f32 算術 ─────────────────────────────────────────────────────────────
    ["__builtin_f32_add", ([a, b]) => primitive(Math.fround(v(a) + v(b)))],
    ["__builtin_f32_sub", ([a, b]) => primitive(Math.fround(v(a) - v(b)))],
    ["__builtin_f32_mul", ([a, b]) => primitive(Math.fround(v(a) * v(b)))],
    ["__builtin_f32_div", ([a, b]) => primitive(Math.fround(v(a) / v(b)))],
    ["__builtin_f32_mod", ([a, b]) => primitive(Math.fround(v(a) % v(b)))],
    ["__builtin_f32_eq",  ([a, b]) => primitive(v(a) === v(b) ? 1 : 0)],
    ["__builtin_f32_lt",  ([a, b]) => primitive(v(a) < v(b) ? 1 : 0)],
    ["__builtin_f32_gt",  ([a, b]) => primitive(v(a) > v(b) ? 1 : 0)],
    ["__builtin_f32_neg", ([a])    => primitive(Math.fround(-v(a)))],

    // ── i64 算術（BigInt で演算、number で保持） ──────────────────────────────
    ["__builtin_i64_add", ([a, b]) => primitive(n64(toI64(v(a)) + toI64(v(b))))],
    ["__builtin_i64_sub", ([a, b]) => primitive(n64(toI64(v(a)) - toI64(v(b))))],
    ["__builtin_i64_mul", ([a, b]) => primitive(n64(toI64(v(a)) * toI64(v(b))))],
    ["__builtin_i64_div", ([a, b]) => primitive(n64(toI64(v(a)) / toI64(v(b))))],
    ["__builtin_i64_mod", ([a, b]) => primitive(n64(toI64(v(a)) % toI64(v(b))))],
    ["__builtin_i64_eq",  ([a, b]) => primitive(toI64(v(a)) === toI64(v(b)) ? 1 : 0)],
    ["__builtin_i64_lt",  ([a, b]) => primitive(toI64(v(a)) < toI64(v(b)) ? 1 : 0)],
    ["__builtin_i64_gt",  ([a, b]) => primitive(toI64(v(a)) > toI64(v(b)) ? 1 : 0)],
    ["__builtin_i64_neg", ([a])    => primitive(n64(-toI64(v(a))))],

    // ── u64 算術 ─────────────────────────────────────────────────────────────
    ["__builtin_u64_add", ([a, b]) => primitive(n64(toU64(v(a)) + toU64(v(b))))],
    ["__builtin_u64_sub", ([a, b]) => primitive(n64(toU64(v(a)) - toU64(v(b))))],
    ["__builtin_u64_mul", ([a, b]) => primitive(n64(toU64(v(a)) * toU64(v(b))))],
    ["__builtin_u64_div", ([a, b]) => primitive(n64(toU64(v(a)) / toU64(v(b))))],
    ["__builtin_u64_mod", ([a, b]) => primitive(n64(toU64(v(a)) % toU64(v(b))))],
    ["__builtin_u64_eq",  ([a, b]) => primitive(toU64(v(a)) === toU64(v(b)) ? 1 : 0)],
    ["__builtin_u64_lt",  ([a, b]) => primitive(toU64(v(a)) < toU64(v(b)) ? 1 : 0)],
    ["__builtin_u64_gt",  ([a, b]) => primitive(toU64(v(a)) > toU64(v(b)) ? 1 : 0)],

    // ── f64 算術（JS number は IEEE 754 倍精度なのでそのまま） ────────────────
    ["__builtin_f64_add", ([a, b]) => primitive(v(a) + v(b))],
    ["__builtin_f64_sub", ([a, b]) => primitive(v(a) - v(b))],
    ["__builtin_f64_mul", ([a, b]) => primitive(v(a) * v(b))],
    ["__builtin_f64_div", ([a, b]) => primitive(v(a) / v(b))],
    ["__builtin_f64_mod", ([a, b]) => primitive(v(a) % v(b))],
    ["__builtin_f64_eq",  ([a, b]) => primitive(v(a) === v(b) ? 1 : 0)],
    ["__builtin_f64_lt",  ([a, b]) => primitive(v(a) < v(b) ? 1 : 0)],
    ["__builtin_f64_gt",  ([a, b]) => primitive(v(a) > v(b) ? 1 : 0)],
    ["__builtin_f64_neg", ([a])    => primitive(-v(a))],

    // ── 論理演算 ─────────────────────────────────────────────────────────────
    ["__builtin_i32_or",  ([a, b]) => primitive(v(a) | v(b))],
    ["__builtin_i32_and", ([a, b]) => primitive(v(a) & v(b))],
    ["__builtin_i32_not", ([a])    => primitive(v(a) === 0 ? 1 : 0)],
    ["__builtin_u32_or",  ([a, b]) => primitive((v(a) | v(b)) >>> 0)],
    ["__builtin_u32_and", ([a, b]) => primitive((v(a) & v(b)) >>> 0)],
    ["__builtin_i64_or",  ([a, b]) => primitive(n64(toI64(v(a)) | toI64(v(b))))],
    ["__builtin_i64_and", ([a, b]) => primitive(n64(toI64(v(a)) & toI64(v(b))))],
    ["__builtin_i64_not", ([a])    => primitive(v(a) === 0 ? 1 : 0)],
    ["__builtin_u64_or",  ([a, b]) => primitive(n64(toU64(v(a)) | toU64(v(b))))],
    ["__builtin_u64_and", ([a, b]) => primitive(n64(toU64(v(a)) & toU64(v(b))))],
    ["__builtin_u64_not", ([a])    => primitive(v(a) === 0 ? 1 : 0)],

    // ── ビットシフト ─────────────────────────────────────────────────────────
    ["__builtin_i32_shl", ([a, b]) => primitive(v(a) << v(b))],
    ["__builtin_i32_shr", ([a, b]) => primitive(v(a) >> v(b))],
    ["__builtin_u32_shl", ([a, b]) => primitive((v(a) >>> 0) << v(b))],
    ["__builtin_u32_shr", ([a, b]) => primitive((v(a) >>> 0) >>> v(b))],
    ["__builtin_i64_shl", ([a, b]) => primitive(n64(toI64(v(a)) << BigInt(v(b) & 63)))],
    ["__builtin_i64_shr", ([a, b]) => primitive(n64(toI64(v(a)) >> BigInt(v(b) & 63)))],
    ["__builtin_u64_shl", ([a, b]) => primitive(n64(toU64(v(a)) << BigInt(v(b) & 63)))],
    ["__builtin_u64_shr", ([a, b]) => primitive(n64(toU64(v(a)) >> BigInt(v(b) & 63)))],

    // ── 浮動小数点演算（f32/f64） ─────────────────────────────────────────────
    ["__builtin_f32_abs",     ([a]) => primitive(Math.fround(Math.abs(v(a))))],
    ["__builtin_f32_sqrt",    ([a]) => primitive(Math.fround(Math.sqrt(v(a))))],
    ["__builtin_f32_floor",   ([a]) => primitive(Math.fround(Math.floor(v(a))))],
    ["__builtin_f32_ceil",    ([a]) => primitive(Math.fround(Math.ceil(v(a))))],
    ["__builtin_f32_trunc",   ([a]) => primitive(Math.fround(Math.trunc(v(a))))],
    ["__builtin_f32_nearest", ([a]) => primitive(Math.fround(Math.round(v(a))))],
    ["__builtin_f32_min",     ([a, b]) => primitive(Math.fround(Math.min(v(a), v(b))))],
    ["__builtin_f32_max",     ([a, b]) => primitive(Math.fround(Math.max(v(a), v(b))))],
    ["__builtin_f64_abs",     ([a]) => primitive(Math.abs(v(a)))],
    ["__builtin_f64_sqrt",    ([a]) => primitive(Math.sqrt(v(a)))],
    ["__builtin_f64_floor",   ([a]) => primitive(Math.floor(v(a)))],
    ["__builtin_f64_ceil",    ([a]) => primitive(Math.ceil(v(a)))],
    ["__builtin_f64_trunc",   ([a]) => primitive(Math.trunc(v(a)))],
    ["__builtin_f64_nearest", ([a]) => primitive(Math.round(v(a)))],
    ["__builtin_f64_min",     ([a, b]) => primitive(Math.min(v(a), v(b)))],
    ["__builtin_f64_max",     ([a, b]) => primitive(Math.max(v(a), v(b)))],

    // ── 超越関数（予約済み命令、インタープリタでは実装あり） ──────────────────
    ["__builtin_f32_sin",   ([a]) => primitive(Math.fround(Math.sin(v(a))))],
    ["__builtin_f32_cos",   ([a]) => primitive(Math.fround(Math.cos(v(a))))],
    ["__builtin_f32_tan",   ([a]) => primitive(Math.fround(Math.tan(v(a))))],
    ["__builtin_f32_exp",   ([a]) => primitive(Math.fround(Math.exp(v(a))))],
    ["__builtin_f32_log",   ([a]) => primitive(Math.fround(Math.log(v(a))))],
    ["__builtin_f32_pow",   ([a, b]) => primitive(Math.fround(Math.pow(v(a), v(b))))],
    ["__builtin_f32_atan",  ([a]) => primitive(Math.fround(Math.atan(v(a))))],
    ["__builtin_f32_atan2", ([a, b]) => primitive(Math.fround(Math.atan2(v(a), v(b))))],
    ["__builtin_f64_sin",   ([a]) => primitive(Math.sin(v(a)))],
    ["__builtin_f64_cos",   ([a]) => primitive(Math.cos(v(a)))],
    ["__builtin_f64_tan",   ([a]) => primitive(Math.tan(v(a)))],
    ["__builtin_f64_exp",   ([a]) => primitive(Math.exp(v(a)))],
    ["__builtin_f64_log",   ([a]) => primitive(Math.log(v(a)))],
    ["__builtin_f64_pow",   ([a, b]) => primitive(Math.pow(v(a), v(b)))],
    ["__builtin_f64_atan",  ([a]) => primitive(Math.atan(v(a)))],
    ["__builtin_f64_atan2", ([a, b]) => primitive(Math.atan2(v(a), v(b)))],

    // ── 型変換 ───────────────────────────────────────────────────────────────
    ["__builtin_i32_to_f32", ([a]) => primitive(Math.fround(v(a) | 0))],
    ["__builtin_i32_to_u32", ([a]) => primitive((v(a) | 0) >>> 0)],
    ["__builtin_i32_to_f64", ([a]) => primitive(v(a) | 0)],
    ["__builtin_u32_to_f32", ([a]) => primitive(Math.fround(v(a) >>> 0))],
    ["__builtin_u32_to_i32", ([a]) => primitive((v(a) >>> 0) | 0)],
    ["__builtin_u32_to_f64", ([a]) => primitive(v(a) >>> 0)],
    ["__builtin_f32_to_i32", ([a]) => primitive(Math.trunc(v(a)) | 0)],
    ["__builtin_f32_to_u32", ([a]) => primitive(Math.trunc(v(a)) >>> 0)],
    ["__builtin_i32_to_i64", ([a]) => primitive(n64(toI64(v(a) | 0)))],
    ["__builtin_u32_to_u64", ([a]) => primitive(n64(toU64(v(a) >>> 0)))],
    ["__builtin_i64_to_i32", ([a]) => primitive(Number(BigInt.asIntN(32, toI64(v(a)))))],
    ["__builtin_u64_to_u32", ([a]) => primitive(Number(BigInt.asUintN(32, toU64(v(a)))))],
    ["__builtin_f32_to_f64", ([a]) => primitive(Math.fround(v(a)))],
    ["__builtin_f64_to_f32", ([a]) => primitive(Math.fround(v(a)))],
    ["__builtin_f64_to_i64", ([a]) => primitive(n64(toI64(Math.trunc(v(a)))))],
    ["__builtin_i64_to_f64", ([a]) => primitive(Number(toI64(v(a))))],
    ["__builtin_u64_to_f64", ([a]) => primitive(Number(toU64(v(a))))],

    // ── メモリ管理 ───────────────────────────────────────────────────────────
    ["__builtin_malloc",      ([size]) => primitive(HeapManager.alloc(v(size)))],
    ["__builtin_free",        ([ptr])  => { HeapManager.free(v(ptr)); return voidValue(); }],
    ["__builtin_mem_read8",   ([ptr, off]) => HeapManager.read(v(ptr) + v(off))],
    ["__builtin_mem_read16",  ([ptr, off]) => HeapManager.read(v(ptr) + v(off))],
    ["__builtin_mem_read32",  ([ptr, off]) => HeapManager.read(v(ptr) + v(off))],
    ["__builtin_mem_read64",  ([ptr, off]) => HeapManager.read(v(ptr) + v(off))],
    ["__builtin_mem_write8",  ([ptr, off, val]) => { HeapManager.write(v(ptr) + v(off), val); return voidValue(); }],
    ["__builtin_mem_write16", ([ptr, off, val]) => { HeapManager.write(v(ptr) + v(off), val); return voidValue(); }],
    ["__builtin_mem_write32", ([ptr, off, val]) => { HeapManager.write(v(ptr) + v(off), val); return voidValue(); }],
    ["__builtin_mem_write64", ([ptr, off, val]) => { HeapManager.write(v(ptr) + v(off), val); return voidValue(); }],
    ["__builtin_zeroinit",    ([]) => primitive(0)],

    // ── 入出力 ───────────────────────────────────────────────────────────────
    ["__builtin_stdout_write",   ([s]) => { process.stdout.write(runtimeValueToString(s)); return voidValue(); }],
    ["__builtin_stderr_write",   ([s]) => { process.stderr.write(runtimeValueToString(s)); return voidValue(); }],
    ["__builtin_stdin_readline", ([])  => { throw new Error("__builtin_stdin_readline is not supported in this version"); }],

    // ── パニック ─────────────────────────────────────────────────────────────
    ["__builtin_panic", ([msg]) => { throw new PanicError(runtimeValueToString(msg)); }],

    // ── マルチスレッド（シングルスレッドシミュレーション） ────────────────────
    // mutex / condvar は no-op。ID は ThreadManager.nextId() で発行する。
    ["__builtin_mutex_create",      ([])       => primitive(ThreadManager.nextId())],
    ["__builtin_mutex_lock",        ([_m])     => voidValue()],
    ["__builtin_mutex_unlock",      ([_m])     => voidValue()],
    ["__builtin_condvar_create",    ([])       => primitive(ThreadManager.nextId())],
    ["__builtin_condvar_wait",      ([_c, _m]) => voidValue()],
    ["__builtin_condvar_signal",    ([_c])     => voidValue()],
    ["__builtin_condvar_broadcast", ([_c])     => voidValue()],

    // atomic は通常のヒープ読み書き（シングルスレッドなので競合なし、order 引数は無視）
    // 命令名は IR / 言語仕様§9.11 と完全一致させること（MUST）。32bit / 64bit のサフィックスを省略してはならない（MUST NOT）
    ["__builtin_atomic_load32",     ([ptr, _order])               => HeapManager.read(v(ptr))],
    ["__builtin_atomic_store32",    ([ptr, val, _order])          => { HeapManager.write(v(ptr), val); return voidValue(); }],
    ["__builtin_atomic_cas32",      ([ptr, exp, des, _so, _fo])   => {
        const cur = HeapManager.read(v(ptr)) as any;
        if (cur.value === v(exp)) { HeapManager.write(v(ptr), des); return primitive(1); }
        return primitive(0);
    }],
    ["__builtin_atomic_fetch_add32", ([ptr, val, _order]) => {
        const cur = HeapManager.read(v(ptr)) as any;
        HeapManager.write(v(ptr), primitive(cur.value + v(val)));
        return primitive(cur.value);
    }],
    ["__builtin_atomic_fetch_sub32", ([ptr, val, _order]) => {
        const cur = HeapManager.read(v(ptr)) as any;
        HeapManager.write(v(ptr), primitive(cur.value - v(val)));
        return primitive(cur.value);
    }],
    ["__builtin_atomic_load64",     ([ptr, _order])               => HeapManager.read(v(ptr))],
    ["__builtin_atomic_store64",    ([ptr, val, _order])          => { HeapManager.write(v(ptr), val); return voidValue(); }],
    ["__builtin_atomic_cas64",      ([ptr, exp, des, _so, _fo])   => {
        const cur = HeapManager.read(v(ptr)) as any;
        if (cur.value === v(exp)) { HeapManager.write(v(ptr), des); return primitive(1); }
        return primitive(0);
    }],
    ["__builtin_atomic_fetch_add64", ([ptr, val, _order]) => {
        const cur = HeapManager.read(v(ptr)) as any;
        HeapManager.write(v(ptr), primitive(cur.value + v(val)));
        return primitive(cur.value);
    }],
    ["__builtin_atomic_fetch_sub64", ([ptr, val, _order]) => {
        const cur = HeapManager.read(v(ptr)) as any;
        HeapManager.write(v(ptr), primitive(cur.value - v(val)));
        return primitive(cur.value);
    }],
    ["__builtin_atomic_fence",      ([_order])                     => voidValue()],

    // __builtin_if / __builtin_while / __builtin_sizeof は evaluator で特別処理

] as [string, BuiltinFn][]);

// スレッドマネージャー（シングルスレッドシミュレーション用）
export class ThreadManager {
    private static tasks: Map<number, { fnName: string; args: RuntimeValue[] }> = new Map();
    private static pools: Map<number, { fnName: string; args: RuntimeValue[] }[]> = new Map();
    private static _nextId = 1;

    // ダミーIDの発行（mutex/condvar 用）
    static nextId(): number { return this._nextId++; }

    static enqueue(fnName: string, args: RuntimeValue[]): number {
        const id = this._nextId++;
        this.tasks.set(id, { fnName, args });
        return id;
    }

    // runner は (fnName, args) → void のコールバック（Evaluator への依存を排除）
    static joinTask(id: number, runner: (fnName: string, args: RuntimeValue[]) => void): void {
        const task = this.tasks.get(id);
        if (task) {
            runner(task.fnName, task.args);
            this.tasks.delete(id);
        }
    }

    static createPool(_size: number): number {
        const id = this._nextId++;
        this.pools.set(id, []);
        return id;
    }

    static submitToPool(poolId: number, fnName: string, args: RuntimeValue[]): void {
        this.pools.get(poolId)?.push({ fnName, args });
    }

    static waitPool(poolId: number, runner: (fnName: string, args: RuntimeValue[]) => void): void {
        for (const task of this.pools.get(poolId) ?? []) {
            runner(task.fnName, task.args);
        }
        this.pools.set(poolId, []);
    }

    static destroyPool(poolId: number): void {
        this.pools.delete(poolId);
    }
}

// パニックエラー
export class PanicError extends Error {
    constructor(message: string) {
        super(`[PANIC] ${message}`);
    }
}

// ヒープ管理（JavaScriptのMapで模倣）
export class HeapManager {
    private static heap: Map<number, RuntimeValue> = new Map();
    private static nextAddr: number = 1000; // 0はヌルポインタ予約

    static alloc(size: number): number {
        const addr = this.nextAddr;
        this.nextAddr += Math.max(size, 0);
        return addr;
    }

    static free(addr: number): void {
        // 簡易実装：実際には解放済みマークをつける
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

// ランタイム値を文字列に変換（I/O用）
// ObjectValue.fields は Record（plain object）なので [] でアクセスする
export function runtimeValueToString(value: RuntimeValue): string {
    if (value.kind === "object" && value.className.split("<")[0] === "Array") {
        const length = value.fields["length"] as any;
        const ptr    = value.fields["ptr"]    as any;
        if (!length || !ptr) return "";

        const len: number = length.kind === "object"
            ? ((length.fields["bits"] as any)?.value ?? 0)
            : (length.value ?? 0);

        const ptrAddr: number = ptr.kind === "primitive"
            ? ptr.value
            : ((ptr.fields?.["bits"] as any)?.value ?? 0);

        let result = "";
        for (let i = 0; i < len; i++) {
            const charVal = HeapManager.read(ptrAddr + i * 4) as any;
            let codePoint: number;
            if (charVal.kind === "primitive") {
                codePoint = charVal.value;
            } else if (charVal.kind === "object") {
                codePoint = (charVal.fields?.["bits"] as any)?.value ?? 0;
            } else {
                codePoint = 0;
            }
            result += String.fromCodePoint(codePoint);
        }
        return result;
    }
    if (value.kind === "primitive") return String(value.value);
    if (value.kind === "void")      return "";
    return `[object ${(value as any).className}]`;
}
```

---

## 7. ノード評価のメインロジック (`evaluator.ts`)

各ASTノードを再帰的に評価するメインロジックを定義する。

```typescript
import * as fs from "fs";
import * as nodePath from "path";
import { ASTNode, ClassDecl, FunctionDecl, MozaicScriptAST } from "./types";
import { RuntimeValue, ObjectValue, primitive, voidValue } from "./values";
import { Environment } from "./environment";
import { builtins, HeapManager, ThreadManager } from "./builtins";

export class Evaluator {
    private loadedFiles: Set<string> = new Set();
    private loadingFiles: Set<string> = new Set();
    private classes: Map<string, ClassDecl> = new Map();
    private functions: Map<string, FunctionDecl> = new Map();
    private globalEnv: Environment = new Environment();
    private currentFileExt: string = ".moc";

    // 制御フローをフラグで管理（throw/catch よりも高速）
    private _hasRet   = false;
    private _retVal: RuntimeValue = voidValue();
    private _hasBreak = false;

    constructor(_baseDir: string) {}

    run(entryPath: string): void {
        this.loadAST(entryPath, null);
        const main = this.functions.get("main");
        if (!main) throw new Error("main() function not found");
        this.callFunction(main, [], this.globalEnv);
    }

    private loadAST(filePath: string, namespace: string | null): void {
        if (this.loadedFiles.has(filePath)) return;
        if (this.loadingFiles.has(filePath)) {
            throw new Error(`Circular import detected: ${filePath}`);
        }
        this.loadingFiles.add(filePath);

        const astPath = filePath + ".ast.json";
        const json = fs.readFileSync(astPath, "utf-8");
        const ast: MozaicScriptAST = JSON.parse(json);

        const basename = nodePath.basename(filePath);
        const fileExt = basename.endsWith(".moc") ? ".moc" : ".moz";

        for (const node of ast.nodes) {
            if (node.type === "ImportDecl") {
                const fileDir = nodePath.dirname(filePath);
                const importPath = nodePath.resolve(fileDir, node.path);
                this.loadAST(importPath, node.namespace);
            }
        }

        for (const node of ast.nodes) {
            if (node.type === "ClassDecl") {
                const key = namespace ? `${namespace}.${node.name}` : node.name;
                for (const method of node.methods) {
                    (method as any)._fileExt = fileExt;
                }
                this.classes.set(key, node);
            } else if (node.type === "FunctionDecl") {
                const key = namespace ? `${namespace}.${node.name}` : node.name;
                (node as any)._fileExt = fileExt;
                this.functions.set(key, node);
            }
        }

        this.loadedFiles.add(filePath);
        this.loadingFiles.delete(filePath);
    }

    // 引数を評価してバッファに格納する（アロケーション削減用）
    // 呼び出し深さ別に事前確保したバッファを再利用することで .map() の都度アロケーションを回避する。
    // `__builtin_thread_spawn` / `__builtin_threadpool_submit` のように引数を長期保持する場合は .map() で別コピーを作成すること。
    private evalArgs(nodes: ASTNode[], env: Environment): RuntimeValue[] {
        const buf = this._argsBufs[this._argsDepth++];
        const n = nodes.length;
        buf.length = n;
        for (let i = 0; i < n; i++) buf[i] = this.eval(nodes[i], env);
        this._argsDepth--;
        return buf;
    }

    private eval(node: ASTNode, env: Environment): RuntimeValue {
        switch (node.type) {
            case "VarDecl": {
                const value = this.eval(node.value, env);
                env.define(node.name, value);
                return voidValue();
            }

            case "Assign": {
                const value = this.eval(node.value, env);
                if (node.target.type === "Identifier") {
                    env.assign(node.target.name, value);
                } else if (node.target.type === "MemberAccess") {
                    const receiver = this.eval(node.target.receiver, env) as ObjectValue;
                    receiver.fields[node.target.member] = value;  // Record アクセス
                }
                return voidValue();
            }

            case "Identifier": return env.get(node.name);

            case "MemberAccess": {
                const receiver = this.eval(node.receiver, env) as ObjectValue;
                const field = receiver.fields[node.member];       // Record アクセス
                if (field === undefined) {
                    throw new Error(`Field not found: ${node.member} on ${receiver.className}`);
                }
                return field;
            }

            case "RawLiteral": return primitive(node.value);
            case "NewExpr":    return this.evalNewExpr(node, env);
            case "MethodCall": return this.evalMethodCall(node, env);
            case "Intrinsic":  return this.evalIntrinsic(node, env);

            case "IfStmt":    { this.evalIfStmt(node, env);    return voidValue(); }
            case "WhileStmt": { this.evalWhileStmt(node, env); return voidValue(); }
            case "ForStmt":   { this.evalForStmt(node, env);   return voidValue(); }

            case "ReturnStmt": {
                // 例外ではなくフラグで return を通知する
                this._retVal = node.value ? this.eval(node.value, env) : voidValue();
                this._hasRet = true;
                return voidValue();
            }

            case "BreakStmt": {
                this._hasBreak = true;
                return voidValue();
            }

            // 並行プリミティブ（スレッド・ミューテックス・条件変数・アトミック）は
            // Intrinsic ノード `__builtin_thread_*`, `__builtin_mutex_*`,
            // `__builtin_condvar_*`, `__builtin_atomic_*32/64`, `__builtin_atomic_fence`
            // として `evalIntrinsic()` 内でハンドリングされる。

            default: return voidValue();
        }
    }

    private evalNewExpr(node: any, env: Environment): RuntimeValue {
        if (node.elements !== undefined) {
            // 文字列リテラル展開
            const classDef    = this.classes.get("Array");
            const lenClassDef = this.classes.get("i32");
            if (!classDef || !lenClassDef) throw new Error("Core library not loaded");

            const fields: Record<string, RuntimeValue> = Object.create(null);
            for (const field of classDef.members) fields[field.name] = primitive(0);

            const lenFields: Record<string, RuntimeValue> = Object.create(null);
            lenFields["bits"] = primitive(node.elements.length);
            fields["length"] = { kind: "object", className: "i32", fields: lenFields, classDef: lenClassDef };

            if (node.elements.length > 0) {
                const addr = HeapManager.alloc(node.elements.length * 4);
                fields["ptr"] = primitive(addr);
                node.elements.forEach((e: any, i: number) => HeapManager.write(addr + i * 4, primitive(e.value)));
            } else {
                fields["ptr"] = primitive(0);
            }

            return { kind: "object", className: node.resolvedType, fields, classDef };
        }

        // 通常のクラスインスタンス化
        const className = node.resolvedType.split("<")[0];
        const classDef = this.classes.get(className);
        if (!classDef) throw new Error(`Unknown class: ${node.resolvedType}`);

        const fields: Record<string, RuntimeValue> = Object.create(null);
        for (const field of classDef.members) fields[field.name] = primitive(0);

        const instance: ObjectValue = { kind: "object", className: node.resolvedType, fields, classDef };

        const constructor = classDef.methods.find(m => m.name === "constructor");
        if (constructor) {
            this.callFunction(constructor, this.evalArgs(node.args, env), env, instance);
        }

        return instance;
    }

    private evalMethodCall(node: any, env: Environment): RuntimeValue {
        const receiver = this.eval(node.receiver, env) as ObjectValue;
        const args = this.evalArgs(node.args, env);

        const method = receiver.classDef.methods.find(m => m.name === node.method);
        if (!method) {
            throw new Error(`Method not found: ${node.method} on ${receiver.className}`);
        }

        if (method.access === "mocp public" && this.currentFileExt === ".moz") {
            throw new Error(`Cannot access mocp public member '${node.method}' from .moz file`);
        }

        return this.callFunction(method, args, env, receiver);
    }

    private evalIntrinsic(node: any, env: Environment): RuntimeValue {
        // __builtin_if / __builtin_while: boolean の bits フィールドを抽出
        if (node.name === "__builtin_if" || node.name === "__builtin_while") {
            const cond = this.eval(node.args[0], env) as any;
            const bits = cond.kind === "object"
                ? (cond.fields["bits"] as any).value  // Record アクセス
                : cond.value;
            return primitive(bits !== 0 ? 1 : 0);
        }

        if (node.name === "__builtin_sizeof") {
            return this.evalSizeof(node.targetType ?? "i32");
        }

        const fn = builtins[node.name];  // Record アクセス
        if (!fn) throw new Error(`Unknown builtin: ${node.name}`);
        return fn(this.evalArgs(node.args, env));
    }

    private evalSizeof(targetType: string): RuntimeValue {
        const className = targetType.split("<")[0];
        const classDef = this.classes.get(className);
        if (!classDef) return primitive(4);

        let totalBytes = 0;
        for (const field of classDef.members) {
            if (field.access === "private") {
                switch (field.resolvedType) {
                    case "_m8":   totalBytes += 1;  break;
                    case "_m16":  totalBytes += 2;  break;
                    case "_m32":  totalBytes += 4;  break;
                    case "_m64":  totalBytes += 8;  break;
                    case "_m128": totalBytes += 16; break;
                    case "_m256": totalBytes += 32; break;
                    case "_m512": totalBytes += 64; break;
                }
            }
        }
        return primitive(totalBytes > 0 ? totalBytes : 4);
    }

    private evalIfStmt(node: any, env: Environment): void {
        const cond = this.eval(node.cond, env) as any;
        if (cond.value !== 0) {
            this.execBody(node.body, env.extend());
        } else if (node.else) {
            if (node.else.type === "IfStmt") {
                this.evalIfStmt(node.else, env);
            } else {
                this.execBody(node.else.body, env.extend());
            }
        }
    }

    private evalWhileStmt(node: any, env: Environment): void {
        while (true) {
            const cond = this.eval(node.cond, env) as any;
            if (cond.value === 0) break;
            this.execBody(node.body, env.extend());
            if (this._hasBreak) { this._hasBreak = false; break; }
            if (this._hasRet) return;
        }
    }

    private evalForStmt(node: any, env: Environment): void {
        const forEnv = env.extend();
        this.eval(node.init, forEnv);
        while (true) {
            const cond = this.eval(node.cond, forEnv) as any;
            if (cond.value === 0) break;
            this.execBody(node.body, forEnv.extend());
            if (this._hasBreak) { this._hasBreak = false; break; }
            if (this._hasRet) return;
            this.eval(node.update, forEnv);
        }
    }

    private callFunction(
        fn: FunctionDecl,
        args: RuntimeValue[],
        env: Environment,
        thisVal?: ObjectValue
    ): RuntimeValue {
        const prevFileExt = this.currentFileExt;
        const fnFileExt = (fn as any)._fileExt;
        if (fnFileExt) this.currentFileExt = fnFileExt;

        const fnEnv = env.extend();
        if (thisVal) fnEnv.define("this", thisVal);
        const nParams = fn.params.length;
        for (let i = 0; i < nParams; i++) fnEnv.define(fn.params[i].name, args[i]);

        this.execBody(fn.body, fnEnv);
        this.currentFileExt = prevFileExt;

        if (this._hasRet) {
            this._hasRet = false;
            const val = this._retVal;
            this._retVal = voidValue();
            return val;
        }
        return voidValue();
    }

    // `__builtin_thread_spawn` / `__builtin_threadpool_submit` のコールバック用（グローバルスコープで実行）
    private callTopFunction(fnName: string, args: RuntimeValue[]): void {
        const fn = this.functions.get(fnName);
        if (!fn) throw new Error(`Thread function not found: ${fnName}`);
        this.callFunction(fn, args, this.globalEnv);
    }

    private execBody(body: ASTNode[], env: Environment): void {
        for (const node of body) {
            this.eval(node, env);
            if (this._hasRet || this._hasBreak) return;
        }
    }
}
```

---

## 8. エントリーポイント (`index.ts`)

最新の実装は §11.6 を参照すること。`Evaluator` はコンストラクタにベースディレクトリを受け取り、`run()` はASTオブジェクトではなくエントリーファイルのパスを受け取る。

```typescript
import * as nodePath from "path";
import { Evaluator } from "./evaluator";
import { PanicError } from "./builtins";

const args = process.argv.slice(2);
if (args.length === 0) {
    console.error("Usage: ts-node index.ts <main.moz.ast.json>");
    process.exit(1);
}

const entryPath = nodePath.resolve(args[0]);
const evaluator = new Evaluator(nodePath.dirname(entryPath));

try {
    evaluator.run(entryPath);
} catch (e) {
    if (e instanceof PanicError) {
        console.error(e.message);
        process.exit(1);
    }
    throw e;
}
```

---

## 9. 実行方法

```bash
# 依存関係のインストール
npm install -D typescript ts-node @types/node

# ASTファイルを実行
ts-node index.ts output.json
```

---

## 10. 実装上の注意事項

- **`__builtin_sizeof`** はクラスの `private` フィールドの型（`_m8`=1, `_m16`=2, `_m32`=4, `_m64`=8, `_m128`=16, `_m256`=32, `_m512`=64バイト）の合計を返す。`evaluator.ts` 内の `evalSizeof()` で実装し、`builtins.ts` には登録しない。
- **制御フロー** は `throw`/`catch` ではなくフラグ（`_hasRet`、`_retVal`、`_hasBreak`）で実現する。`ReturnStmt` / `BreakStmt` を評価するとフラグを立てて `voidValue()` を返し、呼び出し元（`execBody`、ループ評価、`callFunction`）がフラグを確認して処理を打ち切る。
- **並行プリミティブ**（スレッド/ミューテックス/条件変数/アトミック）はすべて `Intrinsic` ノード（`__builtin_thread_*`, `__builtin_mutex_*`, `__builtin_condvar_*`, `__builtin_atomic_*32/64`, `__builtin_atomic_fence`）として表現され、`evalIntrinsic()` 内でハンドリングされる。エンジンはシングルスレッドで動作するためシミュレーションとして処理する: `__builtin_thread_spawn` / `__builtin_threadpool_submit` はタスクキュー（`ThreadManager`）に積み、`__builtin_thread_join` / `__builtin_threadpool_wait` 時に同期的に実行する。`ThreadManager.joinTask()` と `waitPool()` はコールバック（`runner`）を受け取り、Evaluator への直接依存を排除している。`__builtin_mutex_*` / `__builtin_condvar_*` は no-op。`__builtin_atomic_*32/64` は通常のヒープ読み書きとして処理する（`order` は無視）。
- **`ObjectValue.fields`** は `Map` ではなく `Record<string, RuntimeValue>`（`Object.create(null)` で生成したプロトタイプなし plain object）を使用する。アクセスは `fields["key"]` で行い、`fields.get()` / `fields.set()` は使わない。
- **`builtins`** は `Map<string, BuiltinFn>` ではなく `Record<string, BuiltinFn>`（`Object.fromEntries([...])` で生成）を使用する。ルックアップは `builtins[name]` で行う。
- **`__builtin_stdin_readline`** は現バージョンでは未実装（例外をスローする）。
- **ヒープ管理** はJavaScriptの `Map` で模倣しており、実際のメモリアドレスとは異なる。
- **`this` のフィールド更新** はコンストラクタ・メソッド内で `this` を参照して直接変更する形で実装する。
- **ジェネリクス** は単一化済みのASTを受け取るため、エンジン側では型パラメータを意識しなくてよい。
- **`__builtin_if` / `__builtin_while`** は引数として `boolean` の ObjectValue を受け取る。`evalIntrinsic` 内でその `bits` フィールド（PrimitiveValue）を `fields["bits"]` で取り出し、`value !== 0` で分岐を判断する。builtins.ts には登録せず、evaluator.ts 内で特別処理する。
- **`MemberAccess` の代入** は `Assign` ノードの `target` が `MemberAccess` の場合として処理する。`eval` の `Assign` ケースで `target.type === "MemberAccess"` を判定し、対象オブジェクトの `fields[member]` を直接更新する。
- **`callTopFunction()`** は `__builtin_thread_spawn` / `__builtin_threadpool_submit` のコールバック用ヘルパーで、関数名を `this.functions` から引いてグローバルスコープで実行する。

---

## 11. 複数ASTファイルの読み込みと `import` 解決

### 11.1 入力形式

エンジンはエントリーポイントとなるASTファイル（`main.ast.json`）を受け取る。`import` 文の解決はエンジンが行う。

```bash
ts-node index.ts main.ast.json
```

### 11.2 `import` 解決の仕様

エンジンは以下の順序で処理する。

```
1. エントリーポイントのASTを読み込む
2. ASTの先頭にある ImportDecl を検出する
3. ImportDecl の path に対応するASTファイルを読み込む
   （例：import "./core.moc" as * → core.moc.ast.json を読み込む）
4. 読み込んだASTのクラス・関数定義を登録する
5. 再帰的に ImportDecl を解決する
6. すべての import が解決されたら main() を実行する
```

### 11.3 ASTファイルの命名規則

| ソースファイル | ASTファイル |
|----------------|-------------|
| `core.moc` | `core.moc.ast.json` |
| `main.moz` | `main.moz.ast.json` |
| `math.moz` | `math.moz.ast.json` |

ASTファイルはソースファイルと同じディレクトリに配置する。

### 11.4 名前空間の解決

`import "./math.moz" as Math` のように名前空間付きでインポートされた場合、エンジンは該当ファイルのクラス・関数を名前空間プレフィックス付きで登録する。

```typescript
// 名前空間付きの登録例
// import "./math.moz" as Math の場合
// Math.add → "Math.add" として登録
this.functions.set(`${namespace}.${fn.name}`, fn);
this.classes.set(`${namespace}.${cls.name}`, cls);

// as * の場合はプレフィックスなしで登録
this.functions.set(fn.name, fn);
this.classes.set(cls.name, cls);
```

### 11.5 循環インポートの検出

エンジンは **2つの** Setで状態を管理する。`loadedFiles`（読み込み完了済み）と `loadingFiles`（現在処理中）を分けることで、共有インポート（複数のファイルが同じファイルをインポートする）と真の循環インポートを区別する。

```typescript
private loadedFiles: Set<string> = new Set();    // 読み込み完了済み（再処理しない）
private loadingFiles: Set<string> = new Set();   // 現在読み込み中（循環検出）

private loadAST(filePath: string, namespace: string | null): void {
    // 読み込み済みなら再処理しない（shared import は正常）
    if (this.loadedFiles.has(filePath)) return;

    // 現在処理中なら循環インポート
    if (this.loadingFiles.has(filePath)) {
        throw new Error(`Circular import detected: ${filePath}`);
    }
    this.loadingFiles.add(filePath);

    // ... 処理 ...

    this.loadedFiles.add(filePath);
    this.loadingFiles.delete(filePath);
}
```

### 11.6 `index.ts` の更新

```typescript
import * as fs from "fs";
import * as nodePath from "path";
import { Evaluator } from "./evaluator";
import { MozaicScriptAST } from "./types";
import { PanicError } from "./builtins";

const args = process.argv.slice(2);
if (args.length === 0) {
    console.error("Usage: ts-node index.ts <main.moz.ast.json>");
    process.exit(1);
}

const entryPath = nodePath.resolve(args[0]);
const evaluator = new Evaluator(nodePath.dirname(entryPath));

try {
    evaluator.run(entryPath);
} catch (e) {
    if (e instanceof PanicError) {
        console.error(e.message);
        process.exit(1);
    }
    throw e;
}
```

`Evaluator` のコンストラクタはベースディレクトリを受け取る（実際にはエントリーファイルと同じディレクトリ）。`loadAST()` の実装は §7 の `Evaluator` クラスを参照すること。

---

## 12. `this` のフィールド更新とオブジェクトの参照セマンティクス

### 12.1 オブジェクトは参照として扱う

エンジン内部でオブジェクトは常に参照として扱われる。つまりオブジェクトをコピーせず、同じオブジェクトへの参照を共有する。

これにより `this.bits = raw` のような代入が呼び出し元にも反映される。

**例：コンストラクタ内でのフィールド更新**

```
1. new i32(10) が呼ばれる
2. エンジンが i32 のインスタンスを生成（bits = 0 で初期化）
3. コンストラクタ内で this.bits = raw が実行される
4. this はインスタンスへの参照なので、インスタンスの bits が更新される
5. コンストラクタ終了後、呼び出し元に同じインスタンスの参照が返る
```

### 12.2 `MemberAccess` ノードの評価規則

**参照（読み取り）**

`this.bits` のような `MemberAccess` ノードを評価する場合：

1. `receiver`（この場合 `this`）を評価してオブジェクトを取得する
2. そのオブジェクトの `fields` から `member` の値を取得して返す

**代入（書き込み）**

`Assign` ノードの `target` が `MemberAccess` の場合：

1. `target.receiver` を評価してオブジェクトを取得する
2. `value` を評価して書き込む値を取得する
3. そのオブジェクトの `fields` の `member` を更新する
4. オブジェクトは参照なので呼び出し元にも変更が反映される

### 12.3 `mocp public` のアクセス制御

`mocp public` メンバーへのアクセスは `.moz` ファイル由来のASTからは禁止される。

エンジンはノードの評価時に以下を確認する。

1. `MethodCall` または `MemberAccess` のターゲットメソッド・フィールドのアクセス修飾子を確認する
2. 呼び出し元のファイルが `.moz` であり、ターゲットが `mocp public` の場合はランタイムエラーとする

**呼び出し元ファイルの追跡方法**

ASTファイルの拡張子（`.moz` / `.moc`）をロード時に記録し、評価時に参照する。

```
core.moc.ast.json をロード → このファイル由来のノードは .moc として記録
main.moz.ast.json をロード → このファイル由来のノードは .moz として記録
```

- `.moz` 由来のノードから `mocp public` メンバーを呼び出した場合 → ランタイムエラー
- `.moc` 由来のノードから `mocp public` メンバーを呼び出した場合 → 許可
