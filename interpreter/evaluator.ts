import * as fs from "fs";
import * as nodePath from "path";
import { ASTNode, ClassDecl, FunctionDecl, MozaicScriptAST } from "./types";
import { RuntimeValue, ObjectValue, primitive, voidValue } from "./values";
import { Environment } from "./environment";
import { builtins, PanicError, HeapManager } from "./builtins";

class ReturnSignal {
    constructor(public value: RuntimeValue) {}
}

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

        // ImportDecl を先に再帰処理
        for (const node of ast.nodes) {
            if (node.type === "ImportDecl") {
                const fileDir = nodePath.dirname(filePath);
                const importPath = nodePath.resolve(fileDir, node.path);
                this.loadAST(importPath, node.namespace);
            }
        }

        // クラス・関数を登録
        for (const node of ast.nodes) {
            if (node.type === "ClassDecl") {
                const key = namespace ? `${namespace}.${node.name}` : node.name;
                // クラスの全メソッドにソースファイル拡張子を付与
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
            // フィールドを primitive(0) で初期化
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

            // 各文字をヒープに書き込む
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

        // コンストラクタを呼び出し
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

        // mocp public アクセス制御
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
