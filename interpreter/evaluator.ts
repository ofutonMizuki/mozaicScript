import * as fs from "fs";
import * as nodePath from "path";
import { ASTNode, ClassDecl, FunctionDecl, MozaicScriptAST } from "./types";
import { RuntimeValue, ObjectValue, primitive, voidValue } from "./values";
import { Environment } from "./environment";
import { builtins, HeapManager, ThreadManager, runtimeValueToString } from "./builtins";

export class Evaluator {
    private loadedFiles: Set<string> = new Set();
    private loadingFiles: Set<string> = new Set();
    private classes: Map<string, ClassDecl> = new Map();
    private functions: Map<string, FunctionDecl> = new Map();
    private globalEnv: Environment = new Environment();
    private currentFileExt: string = ".moc";
    private currentTypeSubst: Map<string, string> = new Map();

    // Control-flow signals (replace throw/catch for return and break)
    private _hasRet   = false;
    private _retVal: RuntimeValue = voidValue();
    private _hasBreak = false;

    // Pre-allocated args buffers indexed by call depth (user request: 配列の確保を事前に)
    private readonly _argsBufs: RuntimeValue[][] = Array.from({ length: 16 }, () => []);
    private _argsDepth = 0;

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
                for (const method of node.methods) {
                    (method as any)._fileExt = fileExt;
                }
                if (namespace) {
                    this.classes.set(`${namespace}.${node.name}`, node);
                }
                // シンプル名でも登録（NewExpr の resolvedType は名前空間なし）
                this.classes.set(node.name, node);
            } else if (node.type === "FunctionDecl") {
                (node as any)._fileExt = fileExt;
                if (namespace) {
                    this.functions.set(`${namespace}.${node.name}`, node);
                }
                this.functions.set(node.name, node);
            }
        }

        // トップレベル定数をグローバル環境に定義
        for (const node of ast.nodes) {
            if (node.type === "VarDecl") {
                const val = this.eval(node.value, this.globalEnv);
                this.globalEnv.define(node.name, val);
            }
        }

        this.loadedFiles.add(filePath);
        this.loadingFiles.delete(filePath);
    }

    // Evaluate args into a reusable depth-keyed buffer (avoids .map() allocation per call)
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
                    receiver.fields[node.target.member] = value;
                }
                return voidValue();
            }

            case "Identifier": {
                return env.get(node.name);
            }

            case "MemberAccess": {
                const receiver = this.eval(node.receiver, env) as ObjectValue;
                const field = receiver.fields[node.member];
                if (field === undefined) {
                    throw new Error(`Field not found: ${node.member} on ${receiver.className}`);
                }
                return field;
            }

            case "RawLiteral": {
                return primitive(node.value);
            }

            case "NewExpr": {
                const resolvedType = this.currentTypeSubst.get(node.resolvedType) ?? node.resolvedType;
                return this.evalNewExpr(resolvedType === node.resolvedType ? node : { ...node, resolvedType }, env);
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
                this._retVal = node.value ? this.eval(node.value, env) : voidValue();
                this._hasRet = true;
                return voidValue();
            }

            case "BreakStmt": {
                this._hasBreak = true;
                return voidValue();
            }

            case "BlockStmt": {
                const blockEnv = env.extend();
                for (const stmt of node.body) {
                    this.eval(stmt, blockEnv);
                    if (this._hasRet || this._hasBreak) break;
                }
                return voidValue();
            }

            // ── マルチスレッドノード（シングルスレッドシミュレーション） ──────────
            case "ThreadSpawn": {
                // args stored long-term → must copy, not reuse buffer
                const args = node.args.map((a: ASTNode) => this.eval(a, env));
                const id = ThreadManager.enqueue(node.fnName, args);
                return primitive(id);
            }

            case "ThreadJoin": {
                const id = (this.eval(node.threadId, env) as any).value as number;
                ThreadManager.joinTask(id, (fnName, args) => this.callTopFunction(fnName, args));
                return voidValue();
            }

            case "ThreadPoolCreate": {
                const size = (this.eval(node.size, env) as any).value as number;
                return primitive(ThreadManager.createPool(size));
            }

            case "ThreadPoolSubmit": {
                const poolId = (this.eval(node.pool, env) as any).value as number;
                // args stored long-term → must copy
                const args = node.args.map((a: ASTNode) => this.eval(a, env));
                ThreadManager.submitToPool(poolId, node.fnName, args);
                return voidValue();
            }

            case "ThreadPoolWait": {
                const poolId = (this.eval(node.pool, env) as any).value as number;
                ThreadManager.waitPool(poolId, (fnName, args) => this.callTopFunction(fnName, args));
                return voidValue();
            }

            case "ThreadPoolDestroy": {
                const poolId = (this.eval(node.pool, env) as any).value as number;
                ThreadManager.destroyPool(poolId);
                return voidValue();
            }

            case "MutexCreate":
            case "CondVarCreate": {
                return primitive(ThreadManager.nextId());
            }

            case "MutexLock":
            case "MutexUnlock":
            case "CondVarWait":
            case "CondVarSignal":
            case "CondVarBroadcast": {
                return voidValue();
            }

            case "AtomicLoad": {
                return HeapManager.read((this.eval(node.ptr, env) as any).value);
            }

            case "AtomicStore": {
                HeapManager.write((this.eval(node.ptr, env) as any).value, this.eval(node.value, env));
                return voidValue();
            }

            case "AtomicCas": {
                const addr = (this.eval(node.ptr, env) as any).value;
                const cur  = HeapManager.read(addr) as any;
                const exp  = (this.eval(node.expected, env) as any).value;
                if (cur.value === exp) {
                    HeapManager.write(addr, this.eval(node.desired, env));
                    return primitive(1);
                }
                return primitive(0);
            }

            case "AtomicFetchAdd": {
                const addr = (this.eval(node.ptr, env) as any).value;
                const cur  = HeapManager.read(addr) as any;
                const inc  = (this.eval(node.value, env) as any).value;
                HeapManager.write(addr, primitive(cur.value + inc));
                return primitive(cur.value);
            }

            case "AtomicFetchSub": {
                const addr = (this.eval(node.ptr, env) as any).value;
                const cur  = HeapManager.read(addr) as any;
                const dec  = (this.eval(node.value, env) as any).value;
                HeapManager.write(addr, primitive(cur.value - dec));
                return primitive(cur.value);
            }

            default:
                return voidValue();
        }
    }

    private evalNewExpr(node: any, env: Environment): RuntimeValue {
        if (node.elements !== undefined) {
            const classDef = this.classes.get("Array");
            if (!classDef) throw new Error("Unknown class: Array (core library not loaded)");
            const lenClassDef = this.classes.get("i32");
            if (!lenClassDef) throw new Error("Unknown class: i32 (core library not loaded)");

            const fields: Record<string, RuntimeValue> = Object.create(null);
            for (const field of classDef.members) fields[field.name] = primitive(0);

            const lenFields: Record<string, RuntimeValue> = Object.create(null);
            lenFields["bits"] = primitive(node.elements.length);
            const lenInstance: ObjectValue = {
                kind: "object", className: "i32", fields: lenFields, classDef: lenClassDef,
            };
            fields["length"] = lenInstance;

            if (node.elements.length > 0) {
                const addr = HeapManager.alloc(node.elements.length * 4);
                fields["ptr"] = primitive(addr);
                node.elements.forEach((e: any, i: number) => {
                    HeapManager.write(addr + i * 4, primitive(e.value));
                });
            } else {
                fields["ptr"] = primitive(0);
            }

            return { kind: "object", className: node.resolvedType, fields, classDef };
        }

        const className = node.resolvedType.split("<")[0];
        const classDef = this.classes.get(className);
        if (!classDef) throw new Error(`Unknown class: ${node.resolvedType}`);

        const fields: Record<string, RuntimeValue> = Object.create(null);
        for (const field of classDef.members) fields[field.name] = primitive(0);

        const instance: ObjectValue = {
            kind: "object", className: node.resolvedType, fields, classDef,
        };

        const constructor = classDef.methods.find(m => m.name === "constructor");
        if (constructor) {
            const args = this.evalArgs(node.args, env);
            this.callFunction(constructor, args, env, instance);
        }

        return instance;
    }

    private evalMethodCall(node: any, env: Environment): RuntimeValue {
        // 自由関数呼び出し: receiver が関数識別子の場合
        if (node.receiver.type === "Identifier") {
            const fn = this.functions.get(node.receiver.name);
            if (fn) {
                const args = this.evalArgs(node.args, env);
                return this.callFunction(fn, args, env);
            }
        }

        const receiver = this.eval(node.receiver, env) as ObjectValue;
        const args = this.evalArgs(node.args, env);

        // Array<T> のリファレンス型要素への特別対応
        if (receiver.className.startsWith('Array<') && (node.method === 'operator[]' || node.method === 'operator_set[]')) {
            const elemType = receiver.className.slice(6, receiver.className.lastIndexOf('>'));
            const primTypes = new Set(['i32','u32','f32','f64','i64','u64','boolean','char','_m32','_m64']);
            if (!primTypes.has(elemType)) {
                const refStore: RuntimeValue[] = (receiver as any)._refStore ?? ((receiver as any)._refStore = []);
                const idxObj = args[0] as any;
                const idx = idxObj.fields?.bits?.value ?? idxObj.value ?? 0;
                if (node.method === 'operator_set[]') {
                    refStore[idx] = args[1];
                    return voidValue();
                } else {
                    return refStore[idx] ?? voidValue();
                }
            }
        }

        const method = receiver.classDef.methods.find(m => m.name === node.method);
        if (!method) {
            throw new Error(`Method not found: ${node.method} on ${receiver.className}`);
        }

        if (method.access === "mocp public" && this.currentFileExt === ".moz") {
            throw new Error(
                `Cannot access mocp public member '${node.method}' from .moz file`
            );
        }

        // ジェネリッククラスのメソッド呼び出し時に型パラメータ置換を設定
        const prevSubst = this.currentTypeSubst;
        const lt = receiver.className.indexOf('<');
        if (lt !== -1 && receiver.classDef.typeParams.length > 0) {
            const inner = receiver.className.slice(lt + 1, receiver.className.lastIndexOf('>'));
            const typeArgs = inner.split(',').map(s => s.trim());
            const subst = new Map<string, string>();
            receiver.classDef.typeParams.forEach((tp, i) => {
                if (typeArgs[i]) subst.set(tp, typeArgs[i]);
            });
            this.currentTypeSubst = subst;
        }
        const result = this.callFunction(method, args, env, receiver);
        this.currentTypeSubst = prevSubst;
        return result;
    }

    private evalIntrinsic(node: any, env: Environment): RuntimeValue {
        if (node.name === "__builtin_if" || node.name === "__builtin_while") {
            const cond = this.eval(node.args[0], env) as any;
            const bits = cond.kind === "object"
                ? (cond.fields["bits"] as any).value
                : cond.value;
            return primitive(bits !== 0 ? 1 : 0);
        }

        if (node.name === "__builtin_sizeof") {
            return this.evalSizeof(node.targetType ?? "i32");
        }

        // スレッド・スレッドプール系のビルトイン
        if (node.name === "__builtin_thread_spawn") {
            const fnNameStr = runtimeValueToString(this.eval(node.args[0], env));
            const id = ThreadManager.enqueue(fnNameStr, []);
            return primitive(id);
        }
        if (node.name === "__builtin_thread_join") {
            const id = (this.eval(node.args[0], env) as any).value as number;
            ThreadManager.joinTask(id, (fnName, args) => this.callTopFunction(fnName, args));
            return voidValue();
        }
        if (node.name === "__builtin_threadpool_create") {
            const size = (this.eval(node.args[0], env) as any).value as number;
            return primitive(ThreadManager.createPool(size));
        }
        if (node.name === "__builtin_threadpool_submit") {
            const poolId = (this.eval(node.args[0], env) as any).value as number;
            const fnNameStr = runtimeValueToString(this.eval(node.args[1], env));
            ThreadManager.submitToPool(poolId, fnNameStr, []);
            return voidValue();
        }
        if (node.name === "__builtin_threadpool_wait") {
            const poolId = (this.eval(node.args[0], env) as any).value as number;
            ThreadManager.waitPool(poolId, (fnName, args) => this.callTopFunction(fnName, args));
            return voidValue();
        }
        if (node.name === "__builtin_threadpool_destroy") {
            const poolId = (this.eval(node.args[0], env) as any).value as number;
            ThreadManager.destroyPool(poolId);
            return voidValue();
        }

        const fn = builtins[node.name];
        if (!fn) throw new Error(`Unknown builtin: ${node.name}`);
        const evaledArgs = this.evalArgs(node.args, env);
        return fn(evaledArgs);
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
