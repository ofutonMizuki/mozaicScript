import { ClassDecl } from "./types";

export type RuntimeValue =
    | PrimitiveValue
    | ObjectValue
    | VoidValue;

// _m32 / _m64 相当のプリミティブ値
export interface PrimitiveValue {
    kind: "primitive";
    value: number;
}

// クラスのインスタンス
export interface ObjectValue {
    kind: "object";
    className: string;
    fields: Record<string, RuntimeValue>; // Map より高速な plain object
    classDef: ClassDecl;
}

// void
export interface VoidValue {
    kind: "void";
}

export const primitive = (value: number): PrimitiveValue => ({
    kind: "primitive",
    value,
});

const _VOID: VoidValue = { kind: "void" };
export const voidValue = (): VoidValue => _VOID;
