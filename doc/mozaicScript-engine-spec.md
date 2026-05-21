# 📄 mozaicScript 実行エンジン仕様書 (Interpreter Engine Specification)

本仕様書は mozaicScript 中間表現仕様書が定義するJSON形式のASTを直接実行するインタープリタエンジンの仕様を定義する。実装言語はTypeScriptとする。

---

## 1. 概要・設計方針

- JSON形式のASTを入力として受け取り、直接実行する
- ネイティブコードの生成は行わない
- 主な用途はデバッグ・動作確認・プロトタイピング
- mozaicScriptの型システムはフロントエンドが保証済みとして信頼する（エンジン側で型チェックは行わない）

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
    | MemberAccess;

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
    elements?: RawLiteral[]; // 文字列リテラル展開時のみ（elements がある場合は文字列展開）
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
    fields: Map<string, RuntimeValue>; // フィールド名 → 値
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

export const voidValue = (): VoidValue => ({ kind: "void" });
```

---

## 5. スコープ・環境の管理 (`environment.ts`)

変数のスコープをチェーン構造で管理する。

```typescript
import { RuntimeValue } from "./values";

export class Environment {
    private store: Map<string, RuntimeValue>;
    private parent: Environment | null;

    constructor(parent: Environment | null = null) {
        this.store = new Map();
        this.parent = parent;
    }

    // 変数の取得（親スコープを再帰的に探索）
    get(name: string): RuntimeValue {
        if (this.store.has(name)) {
            return this.store.get(name)!;
        }
        if (this.parent !== null) {
            return this.parent.get(name);
        }
        throw new Error(`Undefined variable: ${name}`);
    }

    // 変数の定義（現在のスコープに追加）
    define(name: string, value: RuntimeValue): void {
        if (this.store.has(name)) {
            throw new Error(`Variable already defined: ${name}`);
        }
        this.store.set(name, value);
    }

    // 変数の再代入（定義済みのスコープを探して更新）
    assign(name: string, value: RuntimeValue): void {
        if (this.store.has(name)) {
            this.store.set(name, value);
            return;
        }
        if (this.parent !== null) {
            this.parent.assign(name, value);
            return;
        }
        throw new Error(`Undefined variable: ${name}`);
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
import { RuntimeValue, primitive, voidValue, ObjectValue } from "./values";

type BuiltinFn = (args: RuntimeValue[]) => RuntimeValue;

// __builtin_* 命令のマップ
export const builtins: Map<string, BuiltinFn> = new Map([

    // 数値演算
    ["__builtin_i32_add", ([a, b]) => primitive((a as any).value + (b as any).value | 0)],
    ["__builtin_i32_sub", ([a, b]) => primitive((a as any).value - (b as any).value | 0)],
    ["__builtin_i32_mul", ([a, b]) => primitive(Math.imul((a as any).value, (b as any).value))],
    ["__builtin_i32_div", ([a, b]) => primitive((a as any).value / (b as any).value | 0)],
    ["__builtin_i32_mod", ([a, b]) => primitive((a as any).value % (b as any).value | 0)],
    ["__builtin_i32_eq",  ([a, b]) => primitive((a as any).value === (b as any).value ? 1 : 0)],
    ["__builtin_i32_lt",  ([a, b]) => primitive((a as any).value < (b as any).value ? 1 : 0)],
    ["__builtin_i32_gt",  ([a, b]) => primitive((a as any).value > (b as any).value ? 1 : 0)],
    ["__builtin_i32_neg", ([a])    => primitive(-(a as any).value | 0)],

    ["__builtin_u32_add", ([a, b]) => primitive(((a as any).value + (b as any).value) >>> 0)],
    ["__builtin_u32_sub", ([a, b]) => primitive(((a as any).value - (b as any).value) >>> 0)],
    ["__builtin_u32_mul", ([a, b]) => primitive(Math.imul((a as any).value, (b as any).value) >>> 0)],
    ["__builtin_u32_div", ([a, b]) => primitive(((a as any).value / (b as any).value) >>> 0)],
    ["__builtin_u32_mod", ([a, b]) => primitive(((a as any).value % (b as any).value) >>> 0)],
    ["__builtin_u32_eq",  ([a, b]) => primitive((a as any).value === (b as any).value ? 1 : 0)],
    ["__builtin_u32_lt",  ([a, b]) => primitive(((a as any).value >>> 0) < ((b as any).value >>> 0) ? 1 : 0)],
    ["__builtin_u32_gt",  ([a, b]) => primitive(((a as any).value >>> 0) > ((b as any).value >>> 0) ? 1 : 0)],

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

    // メモリ管理（ヒープをJavaScriptのMapで模倣）
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
        // 同期的な標準入力読み込み（簡易実装）
        throw new Error("stdin not supported in this version");
    }],

    // パニック
    ["__builtin_panic", ([msg]) => {
        throw new PanicError(runtimeValueToString(msg));
    }],

    // __builtin_if / __builtin_while / __builtin_sizeof は evaluator で特別処理
]);

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

// ランタイム値を文字列に変換（出力用）
export function runtimeValueToString(value: RuntimeValue): string {
    if (value.kind === "object" && value.className.split("<")[0] === "Array") {
        // Array<char> を文字列として出力
        const length = value.fields.get("length") as any;
        const ptr = value.fields.get("ptr") as any;
        if (!length || !ptr) return "";

        // length は i32 ObjectValue（fields.bits）または PrimitiveValue
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
import { builtins, PanicError, HeapManager } from "./builtins";

// 制御フロー用の特殊シグナル
class ReturnSignal { constructor(public value: RuntimeValue) {} }
class BreakSignal {}

export class Evaluator {
    private baseDir: string;
    private loadedFiles: Set<string> = new Set();    // 読み込み完了済み
    private loadingFiles: Set<string> = new Set();   // 現在読み込み中（循環検出）
    private classes: Map<string, ClassDecl> = new Map();
    private functions: Map<string, FunctionDecl> = new Map();
    private globalEnv: Environment = new Environment();
    private currentFileExt: string = ".moc";         // 現在実行中のファイル拡張子

    constructor(baseDir: string) {
        this.baseDir = baseDir;
    }

    run(entryPath: string): void {
        this.loadAST(entryPath, null);
        const main = this.functions.get("main");
        if (!main) throw new Error("main() function not found");
        this.callFunction(main, [], this.globalEnv);
    }

    private loadAST(filePath: string, namespace: string | null): void {
        // 読み込み済みなら再処理しない（shared import は正常）
        if (this.loadedFiles.has(filePath)) return;

        // 現在処理中なら循環インポート
        if (this.loadingFiles.has(filePath)) {
            throw new Error(`Circular import detected: ${filePath}`);
        }
        this.loadingFiles.add(filePath);

        const astPath = filePath + ".ast.json";
        const json = fs.readFileSync(astPath, "utf-8");
        const ast: MozaicScriptAST = JSON.parse(json);

        // ファイル拡張子を判定（mocp public アクセス制御用）
        const basename = nodePath.basename(filePath);
        const fileExt = basename.endsWith(".moc") ? ".moc" : ".moz";

        // ImportDecl を先に再帰処理（インポート元のディレクトリ基準でパスを解決）
        for (const node of ast.nodes) {
            if (node.type === "ImportDecl") {
                const fileDir = nodePath.dirname(filePath);
                const importPath = nodePath.resolve(fileDir, node.path);
                this.loadAST(importPath, node.namespace);
            }
        }

        // クラス・関数を登録（_fileExt を付与して mocp 制御に使用）
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

    // ノードの評価
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
                    receiver.fields.set(node.target.member, value);
                }
                return voidValue();
            }

            case "Identifier": {
                return env.get(node.name);
            }

            case "MemberAccess": {
                const receiver = this.eval(node.receiver, env) as ObjectValue;
                const field = receiver.fields.get(node.member);
                if (field === undefined) {
                    throw new Error(`Field not found: ${node.member} on ${receiver.className}`);
                }
                return field;
            }

            case "RawLiteral": {
                return primitive(node.value);
            }

            case "NewExpr": {
                return this.evalNewExpr(node, env);
            }

            case "MethodCall": {
                return this.evalMethodCall(node, env);
            }

            case "Intrinsic": {
                return this.evalIntrinsic(node, env);
            }

            case "IfStmt": {
                this.evalIfStmt(node, env);
                return voidValue();
            }

            case "WhileStmt": {
                this.evalWhileStmt(node, env);
                return voidValue();
            }

            case "ForStmt": {
                this.evalForStmt(node, env);
                return voidValue();
            }

            case "ReturnStmt": {
                const value = node.value ? this.eval(node.value, env) : voidValue();
                throw new ReturnSignal(value);
            }

            case "BreakStmt": {
                throw new BreakSignal();
            }

            default:
                return voidValue();
        }
    }

    // NewExpr の評価
    private evalNewExpr(node: any, env: Environment): RuntimeValue {
        // 文字列リテラル展開（elements フィールドが存在する場合）
        if (node.elements !== undefined) {
            const classDef = this.classes.get("Array");
            if (!classDef) throw new Error("Unknown class: Array (core library not loaded)");
            const lenClassDef = this.classes.get("i32");
            if (!lenClassDef) throw new Error("Unknown class: i32 (core library not loaded)");

            const instance: ObjectValue = {
                kind: "object",
                className: node.resolvedType,
                fields: new Map(),
                classDef,
            };
            for (const field of classDef.members) {
                instance.fields.set(field.name, primitive(0));
            }

            // length フィールドを i32 ObjectValue として設定
            const lenInstance: ObjectValue = {
                kind: "object",
                className: "i32",
                fields: new Map([["bits", primitive(node.elements.length)]]),
                classDef: lenClassDef,
            };
            instance.fields.set("length", lenInstance);

            // 各文字をヒープに書き込む（空文字列は ptr=0 のまま）
            if (node.elements.length > 0) {
                const addr = HeapManager.alloc(node.elements.length * 4);
                instance.fields.set("ptr", primitive(addr));
                node.elements.forEach((e: any, i: number) => {
                    HeapManager.write(addr + i * 4, primitive(e.value));
                });
            } else {
                instance.fields.set("ptr", primitive(0));
            }

            return instance;
        }

        // 通常のクラスインスタンス化
        const className = node.resolvedType.split("<")[0];
        const classDef = this.classes.get(className);
        if (!classDef) throw new Error(`Unknown class: ${node.resolvedType}`);

        const instance: ObjectValue = {
            kind: "object",
            className: node.resolvedType,
            fields: new Map(),
            classDef,
        };

        // フィールドを primitive(0) で初期化
        for (const field of classDef.members) {
            instance.fields.set(field.name, primitive(0));
        }

        // コンストラクタを呼び出し（callFunction 経由で ReturnSignal・mocp 制御を適用）
        const constructor = classDef.methods.find(m => m.name === "constructor");
        if (constructor) {
            const args = node.args.map((a: ASTNode) => this.eval(a, env));
            this.callFunction(constructor, args, env, instance);
        }

        return instance;
    }

    // MethodCall の評価
    private evalMethodCall(node: any, env: Environment): RuntimeValue {
        const receiver = this.eval(node.receiver, env) as ObjectValue;
        const args = node.args.map((a: ASTNode) => this.eval(a, env));

        const method = receiver.classDef.methods.find(m => m.name === node.method);
        if (!method) {
            throw new Error(`Method not found: ${node.method} on ${receiver.className}`);
        }

        // mocp public アクセス制御（.moz ファイル由来の呼び出しは禁止）
        if (method.access === "mocp public" && this.currentFileExt === ".moz") {
            throw new Error(
                `Cannot access mocp public member '${node.method}' from .moz file`
            );
        }

        return this.callFunction(method, args, env, receiver);
    }

    // Intrinsic の評価
    private evalIntrinsic(node: any, env: Environment): RuntimeValue {
        // __builtin_if / __builtin_while: boolean の bits フィールドを抽出して返す
        if (node.name === "__builtin_if" || node.name === "__builtin_while") {
            const cond = this.eval(node.args[0], env) as any;
            const bits = cond.kind === "object"
                ? (cond.fields.get("bits") as any).value
                : cond.value;
            return primitive(bits !== 0 ? 1 : 0);
        }

        // __builtin_sizeof: targetType からクラスの private フィールドサイズを計算
        if (node.name === "__builtin_sizeof") {
            return this.evalSizeof(node.targetType ?? "i32");
        }

        const fn = builtins.get(node.name);
        if (!fn) throw new Error(`Unknown builtin: ${node.name}`);
        const evaledArgs = node.args.map((a: ASTNode) => this.eval(a, env));
        return fn(evaledArgs);
    }

    // __builtin_sizeof の実装
    // クラスの private フィールドの型に応じてバイト数を合計して返す
    private evalSizeof(targetType: string): RuntimeValue {
        const className = targetType.split("<")[0];
        const classDef = this.classes.get(className);
        if (!classDef) return primitive(4); // フォールバック

        let totalBytes = 0;
        for (const field of classDef.members) {
            if (field.access === "private") {
                switch (field.resolvedType) {
                    case "_m32":  totalBytes += 4;  break;
                    case "_m64":  totalBytes += 8;  break;
                    case "_m128": totalBytes += 16; break;
                    case "_m256": totalBytes += 32; break;
                }
            }
        }
        return primitive(totalBytes > 0 ? totalBytes : 4);
    }

    // IfStmt の評価
    private evalIfStmt(node: any, env: Environment): void {
        const cond = this.eval(node.cond, env) as any;
        if (cond.value !== 0) {
            const bodyEnv = env.extend();
            this.execBody(node.body, bodyEnv);
        } else if (node.else) {
            if (node.else.type === "IfStmt") {
                this.evalIfStmt(node.else, env);
            } else {
                const elseEnv = env.extend();
                this.execBody(node.else.body, elseEnv);
            }
        }
    }

    // WhileStmt の評価
    private evalWhileStmt(node: any, env: Environment): void {
        while (true) {
            const cond = this.eval(node.cond, env) as any;
            if (cond.value === 0) break;
            try {
                const bodyEnv = env.extend();
                this.execBody(node.body, bodyEnv);
            } catch (e) {
                if (e instanceof BreakSignal) break;
                throw e;
            }
        }
    }

    // ForStmt の評価
    private evalForStmt(node: any, env: Environment): void {
        const forEnv = env.extend();
        this.eval(node.init, forEnv);
        while (true) {
            const cond = this.eval(node.cond, forEnv) as any;
            if (cond.value === 0) break;
            try {
                const bodyEnv = forEnv.extend();
                this.execBody(node.body, bodyEnv);
            } catch (e) {
                if (e instanceof BreakSignal) break;
                throw e;
            }
            this.eval(node.update, forEnv);
        }
    }

    // 関数・メソッドの呼び出し
    private callFunction(
        fn: FunctionDecl,
        args: RuntimeValue[],
        env: Environment,
        thisVal?: ObjectValue
    ): RuntimeValue {
        // ソースファイル拡張子を切り替え（mocp public アクセス制御用）
        const prevFileExt = this.currentFileExt;
        const fnFileExt = (fn as any)._fileExt;
        if (fnFileExt) this.currentFileExt = fnFileExt;

        const fnEnv = env.extend();
        if (thisVal) fnEnv.define("this", thisVal);
        fn.params.forEach((p, i) => fnEnv.define(p.name, args[i]));

        try {
            this.execBody(fn.body, fnEnv);
        } catch (e) {
            this.currentFileExt = prevFileExt;
            if (e instanceof ReturnSignal) return e.value;
            throw e;
        }
        this.currentFileExt = prevFileExt;
        return voidValue();
    }

    // ボディの実行
    private execBody(body: ASTNode[], env: Environment): void {
        for (const node of body) {
            this.eval(node, env);
        }
    }
}
```

---

## 8. エントリーポイント (`index.ts`)

```typescript
import * as fs from "fs";
import { Evaluator } from "./evaluator";
import { MozaicScriptAST } from "./types";
import { PanicError } from "./builtins";

const args = process.argv.slice(2);
if (args.length === 0) {
    console.error("Usage: ts-node index.ts <ast.json>");
    process.exit(1);
}

const filePath = args[0];
const json = fs.readFileSync(filePath, "utf-8");
const ast: MozaicScriptAST = JSON.parse(json);

const evaluator = new Evaluator();

try {
    evaluator.run(ast);
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

- **`__builtin_sizeof`** はクラスの `private` フィールドの型（`_m32`=4, `_m64`=8, `_m128`=16, `_m256`=32バイト）の合計を返す。`evaluator.ts` 内の `evalSizeof()` で実装し、`builtins.ts` には登録しない。
- **`__builtin_stdin_readline`** は現バージョンでは未実装。
- **ヒープ管理** はJavaScriptの `Map` で模倣しており、実際のメモリアドレスとは異なる。
- **`this` のフィールド更新** はコンストラクタ・メソッド内で `this` を参照して直接変更する形で実装する。
- **ジェネリクス** は単一化済みのASTを受け取るため、エンジン側では型パラメータを意識しなくてよい。
- **`__builtin_if` / `__builtin_while`** は引数として `boolean` の ObjectValue を受け取る。`evalIntrinsic` 内でその `bits` フィールド（PrimitiveValue）を取り出し、`value !== 0` で分岐を判断する。builtins.ts には登録せず、evaluator.ts 内で特別処理する。
- **`MemberAccess` の代入** は `Assign` ノードの `target` が `MemberAccess` の場合として処理する。`eval` の `Assign` ケースで `target.type === "MemberAccess"` を判定し、対象オブジェクトの `fields` を直接更新する。

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

`Evaluator` のコンストラクタはベースディレクトリを受け取り、相対パスの解決に使用する。

```typescript
export class Evaluator {
    private baseDir: string;
    private loadedFiles: Set<string> = new Set();    // 読み込み完了済み
    private loadingFiles: Set<string> = new Set();   // 現在読み込み中（循環検出）
    private classes: Map<string, ClassDecl> = new Map();
    private functions: Map<string, FunctionDecl> = new Map();
    private globalEnv: Environment = new Environment();
    private currentFileExt: string = ".moc";         // 現在実行中のファイル拡張子

    constructor(baseDir: string) {
        this.baseDir = baseDir;
    }

    run(entryPath: string): void {
        this.loadAST(entryPath, null);
        const main = this.functions.get("main");
        if (!main) throw new Error("main() function not found");
        this.callFunction(main, [], this.globalEnv);
    }

    private loadAST(filePath: string, namespace: string | null): void {
        // 読み込み済みなら再処理しない（shared import は正常）
        if (this.loadedFiles.has(filePath)) return;

        // 現在処理中なら循環インポート
        if (this.loadingFiles.has(filePath)) {
            throw new Error(`Circular import detected: ${filePath}`);
        }
        this.loadingFiles.add(filePath);

        const astPath = filePath + ".ast.json";
        const json = fs.readFileSync(astPath, "utf-8");
        const ast: MozaicScriptAST = JSON.parse(json);

        // ファイル拡張子を判定（mocp public アクセス制御用）
        const basename = nodePath.basename(filePath);
        const fileExt = basename.endsWith(".moc") ? ".moc" : ".moz";

        // ImportDecl を先に再帰処理（インポート元のディレクトリ基準でパスを解決）
        for (const node of ast.nodes) {
            if (node.type === "ImportDecl") {
                const fileDir = nodePath.dirname(filePath);
                const importPath = nodePath.resolve(fileDir, node.path);
                this.loadAST(importPath, node.namespace);
            }
        }

        // クラス・関数定義を登録（_fileExt を付与して mocp 制御に使用）
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
}
```

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
