import { RuntimeValue } from "./values";

export class Environment {
    private store: Record<string, RuntimeValue>;
    private parent: Environment | null;

    constructor(parent: Environment | null = null) {
        this.store = Object.create(null); // プロトタイプなし → 純粋なキー/値ストア
        this.parent = parent;
    }

    get(name: string): RuntimeValue {
        // プロトタイプチェーンなしの hasOwnProperty 相当
        const v = this.store[name];
        if (v !== undefined) return v;
        if (this.parent !== null) return this.parent.get(name);
        throw new Error(`Undefined variable: ${name}`);
    }

    define(name: string, value: RuntimeValue): void {
        this.store[name] = value;
    }

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

    extend(): Environment {
        return new Environment(this);
    }
}
