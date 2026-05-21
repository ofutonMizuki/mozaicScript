import { RuntimeValue } from "./values";

export class Environment {
    private store: Map<string, RuntimeValue>;
    private parent: Environment | null;

    constructor(parent: Environment | null = null) {
        this.store = new Map();
        this.parent = parent;
    }

    get(name: string): RuntimeValue {
        if (this.store.has(name)) {
            return this.store.get(name)!;
        }
        if (this.parent !== null) {
            return this.parent.get(name);
        }
        throw new Error(`Undefined variable: ${name}`);
    }

    define(name: string, value: RuntimeValue): void {
        if (this.store.has(name)) {
            throw new Error(`Variable already defined: ${name}`);
        }
        this.store.set(name, value);
    }

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

    extend(): Environment {
        return new Environment(this);
    }
}
