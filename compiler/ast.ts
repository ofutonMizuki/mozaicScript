// compiler/ast.ts — パーサーが出力する内部パースツリーの型定義

export interface Pos { line: number; col: number; file: string; }

export interface PType {
    name: string;   // "i32", "Array", "_m32", etc.
    args: PType[];  // ジェネリクス引数
}

export type PAccessMod = "public" | "private" | "mocp public";

// ── 式 ──────────────────────────────────────────────────────────────────────

export type PExpr =
    | PBinExpr | PUnaryExpr | PNewExpr
    | PCallExpr | PMethodCallExpr
    | PIndexExpr | PMemberExpr
    | PIdentExpr | PThisExpr
    | PIntLit | PFloatLit | PStrLit | PBoolLit;

export interface PBinExpr        { kind: 'bin';        op: string; left: PExpr; right: PExpr; pos: Pos; }
export interface PUnaryExpr      { kind: 'unary';      op: string; expr: PExpr; pos: Pos; }
export interface PNewExpr        { kind: 'new';        type: PType; args: PExpr[]; pos: Pos; }
// 関数呼び出し（グローバル or __builtin_*）
export interface PCallExpr       { kind: 'call';       name: string; typeArgs: PType[]; args: PExpr[]; pos: Pos; }
// メソッド呼び出し
export interface PMethodCallExpr { kind: 'methodcall'; obj: PExpr; method: string; typeArgs: PType[]; args: PExpr[]; pos: Pos; }
export interface PIndexExpr      { kind: 'index';      obj: PExpr; index: PExpr; pos: Pos; }
export interface PMemberExpr     { kind: 'member';     obj: PExpr; member: string; pos: Pos; }
export interface PIdentExpr      { kind: 'ident';      name: string; pos: Pos; }
export interface PThisExpr       { kind: 'this';       pos: Pos; }
export interface PIntLit         { kind: 'intlit';     value: number; pos: Pos; }
export interface PFloatLit       { kind: 'floatlit';   value: number; pos: Pos; }
export interface PStrLit         { kind: 'strlit';     value: string; pos: Pos; }
export interface PBoolLit        { kind: 'boollit';    value: boolean; pos: Pos; }

// ── 文 ──────────────────────────────────────────────────────────────────────

export type PStmt =
    | PVarDecl | PAssignStmt | PExprStmt
    | PIfStmt | PWhileStmt | PForStmt
    | PReturnStmt | PBreakStmt | PBlockStmt;

export interface PVarDecl    { kind: 'vardecl';  mut: boolean; name: string; type: PType; value: PExpr; pos: Pos; }
export interface PAssignStmt { kind: 'assign';   target: PExpr; value: PExpr; pos: Pos; }
export interface PExprStmt   { kind: 'exprstmt'; expr: PExpr; pos: Pos; }
export interface PIfStmt     { kind: 'if';       cond: PExpr; body: PStmt[]; elseBody: PStmt[] | null; elseIf: PIfStmt | null; pos: Pos; }
export interface PWhileStmt  { kind: 'while';    cond: PExpr; body: PStmt[]; pos: Pos; }
export interface PForStmt    { kind: 'for';      init: PVarDecl; cond: PExpr; update: PAssignStmt | PExprStmt; body: PStmt[]; pos: Pos; }
export interface PReturnStmt { kind: 'return';   value: PExpr | null; pos: Pos; }
export interface PBreakStmt  { kind: 'break';    pos: Pos; }
export interface PBlockStmt  { kind: 'block';    body: PStmt[]; pos: Pos; }

// ── クラスメンバー ─────────────────────────────────────────────────────────

export interface PFieldDecl {
    kind: 'field';
    access: PAccessMod;
    mut: boolean;
    name: string;
    type: PType;
    pos: Pos;
}

export interface PMethodDecl {
    kind: 'method';
    access: PAccessMod;
    name: string;        // "constructor" / "operator+" / "operatorNot" / 通常名
    typeParams: string[];
    params: { name: string; type: PType }[];
    returnType: PType;
    body: PStmt[];
    pos: Pos;
}

export type PClassMember = PFieldDecl | PMethodDecl;

// ── トップレベル宣言 ───────────────────────────────────────────────────────

export interface PClassDecl {
    kind: 'class';
    access: PAccessMod;
    name: string;
    typeParams: string[];
    members: PClassMember[];
    pos: Pos;
}

export interface PFunctionDecl {
    kind: 'function';
    access: PAccessMod;
    name: string;
    typeParams: string[];
    params: { name: string; type: PType }[];
    returnType: PType;
    body: PStmt[];
    pos: Pos;
}

export interface PImportDecl {
    kind: 'import';
    path: string;
    namespace: string | null; // null = as *
    pos: Pos;
}

export interface PTypeAliasDecl {
    kind: 'typealias';
    name: string;
    type: PType;
    pos: Pos;
}

export type PTopLevelDecl =
    | PImportDecl
    | PTypeAliasDecl
    | PClassDecl
    | PFunctionDecl
    | PVarDecl;

export interface PFile {
    filename: string;
    isMoc: boolean;
    decls: PTopLevelDecl[];
}
