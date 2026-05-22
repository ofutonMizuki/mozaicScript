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
    | ThreadSpawn
    | ThreadJoin
    | ThreadPoolCreate
    | ThreadPoolSubmit
    | ThreadPoolWait
    | ThreadPoolDestroy
    | MutexCreate
    | MutexLock
    | MutexUnlock
    | CondVarCreate
    | CondVarWait
    | CondVarSignal
    | CondVarBroadcast
    | AtomicLoad
    | AtomicStore
    | AtomicCas
    | AtomicFetchAdd
    | AtomicFetchSub;

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
    elements?: RawLiteral[];
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
    targetType?: string;
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

export interface ThreadSpawn {
    type: "ThreadSpawn";
    resolvedType: "_m64";
    fnName: string;
    args: ASTNode[];
}

export interface ThreadJoin {
    type: "ThreadJoin";
    resolvedType: "void";
    threadId: ASTNode;
}

export interface ThreadPoolCreate {
    type: "ThreadPoolCreate";
    resolvedType: "_m64";
    size: ASTNode;
}

export interface ThreadPoolSubmit {
    type: "ThreadPoolSubmit";
    resolvedType: "void";
    pool: ASTNode;
    fnName: string;
    args: ASTNode[];
}

export interface ThreadPoolWait {
    type: "ThreadPoolWait";
    resolvedType: "void";
    pool: ASTNode;
}

export interface ThreadPoolDestroy {
    type: "ThreadPoolDestroy";
    resolvedType: "void";
    pool: ASTNode;
}

export interface MutexCreate {
    type: "MutexCreate";
    resolvedType: "_m64";
}

export interface MutexLock {
    type: "MutexLock";
    resolvedType: "void";
    mutexId: ASTNode;
}

export interface MutexUnlock {
    type: "MutexUnlock";
    resolvedType: "void";
    mutexId: ASTNode;
}

export interface CondVarCreate {
    type: "CondVarCreate";
    resolvedType: "_m64";
}

export interface CondVarWait {
    type: "CondVarWait";
    resolvedType: "void";
    condVar: ASTNode;
    mutexId: ASTNode;
}

export interface CondVarSignal {
    type: "CondVarSignal";
    resolvedType: "void";
    condVar: ASTNode;
}

export interface CondVarBroadcast {
    type: "CondVarBroadcast";
    resolvedType: "void";
    condVar: ASTNode;
}

export interface AtomicLoad {
    type: "AtomicLoad";
    resolvedType: "_m32";
    ptr: ASTNode;
}

export interface AtomicStore {
    type: "AtomicStore";
    resolvedType: "void";
    ptr: ASTNode;
    value: ASTNode;
}

export interface AtomicCas {
    type: "AtomicCas";
    resolvedType: "_m32";
    ptr: ASTNode;
    expected: ASTNode;
    desired: ASTNode;
}

export interface AtomicFetchAdd {
    type: "AtomicFetchAdd";
    resolvedType: "_m32";
    ptr: ASTNode;
    value: ASTNode;
}

export interface AtomicFetchSub {
    type: "AtomicFetchSub";
    resolvedType: "_m32";
    ptr: ASTNode;
    value: ASTNode;
}

export interface MozaicScriptAST {
    mozaicScript: string;
    nodes: ASTNode[];
}
