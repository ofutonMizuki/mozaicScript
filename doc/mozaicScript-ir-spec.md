# 📄 mozaicScript 中間表現仕様書 (IR Specification)

本仕様書は mozaicScript 言語仕様書に基づき、フロントエンドが出力するJSON形式の中間表現（AST）の仕様を定義する。

---

## 1. 基本方針

- フォーマット：JSON
- 演算子オーバーロード・`if`/`while`/`<=`/`>=` の脱糖済み
- 型チェック済み（すべての式ノードに `resolvedType` を付与）
- バックエンドはこのJSONのみをインプットとして動作しなければならない（**MUST**）
- バックエンドは `resolvedType` を信頼してよく、独自に型推論を行う必要はない

---

## 2. トップレベル構造

```json
{
    "mozaicScript": "0.2.3",
    "nodes": [...]
}
```

---

## 3. ノード一覧

| カテゴリ | ノード種別 |
|----------|-----------|
| 宣言 | `ImportDecl`, `ClassDecl`, `FunctionDecl`, `VarDecl`, `TypeAliasDecl` |
| 式 | `MethodCall`, `NewExpr`, `Identifier`, `Intrinsic`, `Assign`, `MemberAccess` |
| 文 | `IfStmt`, `ElseStmt`, `WhileStmt`, `ForStmt`, `ReturnStmt`, `BreakStmt` |
| リテラル | `RawLiteral` |
| スレッド | `ThreadSpawn`, `ThreadJoin` |
| スレッドプール | `ThreadPoolCreate`, `ThreadPoolSubmit`, `ThreadPoolWait`, `ThreadPoolDestroy` |
| ミューテックス | `MutexCreate`, `MutexLock`, `MutexUnlock` |
| 条件変数 | `CondVarCreate`, `CondVarWait`, `CondVarSignal`, `CondVarBroadcast` |
| アトミック | `AtomicLoad`, `AtomicStore`, `AtomicCas`, `AtomicFetchAdd`, `AtomicFetchSub` |

---

## 4. 共通ルール

- すべてのノードは `type` フィールドを持つ（**MUST**）
- 式ノードはすべて `resolvedType` フィールドを持つ（**MUST**）
- `resolvedType` の値はジェネリクス単一化済みの完全な型名とする（例：`Result<i32>`）
- `ImportDecl` ノードはASTの先頭にのみ出現する（**MUST**）

---

## 5. ノード定義

### ImportDecl

```json
// import "./core.moc" as *;
{ "type": "ImportDecl", "path": "./core.moc", "namespace": null }

// import "./math.moz" as Math;
{ "type": "ImportDecl", "path": "./math.moz", "namespace": "Math" }
```

- `namespace` が `null` の場合は `as *`（グローバル展開）を意味する

### TypeAliasDecl

```json
// type char = u32;
{
    "type": "TypeAliasDecl",
    "name": "char",
    "resolvedType": "u32"
}
```

### VarDecl

`const` と `let` の区別はフロントエンドの責務であり、ASTには存在しない。どちらも `VarDecl` として出力される。

```json
{
    "type": "VarDecl",
    "name": "a",
    "resolvedType": "i32",
    "value": {
        "type": "NewExpr",
        "resolvedType": "i32",
        "args": [{ "type": "RawLiteral", "kind": "int", "value": 10 }]
    }
}
```

### ClassDecl

```json
{
    "type": "ClassDecl",
    "name": "i32",
    "access": "public",
    "typeParams": [],
    "members": [{
        "type": "FieldDecl",
        "name": "bits",
        "access": "private",
        "resolvedType": "_m32"
    }],
    "methods": [{
        "type": "FunctionDecl",
        "name": "operator+",
        "access": "public",
        "params": [{ "name": "other", "resolvedType": "i32" }],
        "returnType": "i32",
        "body": [...]
    }]
}
```

### FunctionDecl

```json
{
    "type": "FunctionDecl",
    "name": "divide",
    "access": "public",
    "typeParams": [],
    "params": [
        { "name": "a", "resolvedType": "i32" },
        { "name": "b", "resolvedType": "i32" }
    ],
    "returnType": "Result<i32>",
    "body": [...]
}
```

### MethodCall（演算子オーバーロード脱糖済み）

```json
{
    "type": "MethodCall",
    "resolvedType": "i32",
    "receiver": { "type": "Identifier", "name": "a", "resolvedType": "i32" },
    "method": "operator+",
    "args": [{ "type": "Identifier", "name": "b", "resolvedType": "i32" }]
}
```

### NewExpr

```json
{
    "type": "NewExpr",
    "resolvedType": "Array<i32>",
    "args": [{ "type": "Identifier", "name": "size", "resolvedType": "i32" }]
}
```

### Assign

```json
{
    "type": "Assign",
    "target": { "type": "Identifier", "name": "a", "resolvedType": "i32" },
    "value": {
        "type": "NewExpr",
        "resolvedType": "i32",
        "args": [{ "type": "RawLiteral", "kind": "int", "value": 10 }]
    }
}
```

### Intrinsic

通常の組み込み命令：

```json
{
    "type": "Intrinsic",
    "name": "__builtin_i32_add",
    "resolvedType": "_m32",
    "args": [
        { "type": "Identifier", "name": "a", "resolvedType": "_m32" },
        { "type": "Identifier", "name": "b", "resolvedType": "_m32" }
    ]
}
```

`__builtin_sizeof` は `targetType` フィールドに単一化済みの具体的な型名を持つ。

```json
{
    "type": "Intrinsic",
    "name": "__builtin_sizeof",
    "resolvedType": "_m32",
    "targetType": "i32",
    "args": []
}
```

### IfStmt（`__builtin_if` 脱糖済み）

```json
{
    "type": "IfStmt",
    "cond": {
        "type": "Intrinsic",
        "name": "__builtin_if",
        "resolvedType": "_m32",
        "args": [{
            "type": "MethodCall",
            "resolvedType": "boolean",
            "receiver": { "type": "Identifier", "name": "a", "resolvedType": "i32" },
            "method": "operator==",
            "args": [{ "type": "Identifier", "name": "b", "resolvedType": "i32" }]
        }]
    },
    "body": [...]
}
```

### WhileStmt（`__builtin_while` 脱糖済み）

```json
{
    "type": "WhileStmt",
    "cond": {
        "type": "Intrinsic",
        "name": "__builtin_while",
        "resolvedType": "_m32",
        "args": [{
            "type": "MethodCall",
            "resolvedType": "boolean",
            "receiver": { "type": "Identifier", "name": "i", "resolvedType": "i32" },
            "method": "operator<",
            "args": [{ "type": "Identifier", "name": "len", "resolvedType": "i32" }]
        }]
    },
    "body": [...]
}
```

### ForStmt（`init` / `cond` / `update` / `body` に分解）

```json
{
    "type": "ForStmt",
    "init": {
        "type": "VarDecl",
        "name": "i",
        "resolvedType": "i32",
        "value": {
            "type": "NewExpr",
            "resolvedType": "i32",
            "args": [{ "type": "RawLiteral", "kind": "int", "value": 0 }]
        }
    },
    "cond": {
        "type": "Intrinsic",
        "name": "__builtin_if",
        "resolvedType": "_m32",
        "args": [{
            "type": "MethodCall",
            "resolvedType": "boolean",
            "receiver": { "type": "Identifier", "name": "i", "resolvedType": "i32" },
            "method": "operator<",
            "args": [{ "type": "Identifier", "name": "limit", "resolvedType": "i32" }]
        }]
    },
    "update": {
        "type": "Assign",
        "target": { "type": "Identifier", "name": "i", "resolvedType": "i32" },
        "value": {
            "type": "MethodCall",
            "resolvedType": "i32",
            "receiver": { "type": "Identifier", "name": "i", "resolvedType": "i32" },
            "method": "operator+",
            "args": [{
                "type": "NewExpr",
                "resolvedType": "i32",
                "args": [{ "type": "RawLiteral", "kind": "int", "value": 1 }]
            }]
        }
    },
    "body": [...]
}
```

### IfStmt（`else` / `else if` あり）

`else if` は脱糖によりネストされた `IfStmt` として表現される。

```json
{
    "type": "IfStmt",
    "cond": { "type": "Intrinsic", "name": "__builtin_if", "args": [...] },
    "body": [...],
    "else": {
        "type": "IfStmt",
        "cond": { "type": "Intrinsic", "name": "__builtin_if", "args": [...] },
        "body": [...],
        "else": {
            "type": "ElseStmt",
            "body": [...]
        }
    }
}
```

- `else` フィールドは省略可能（`else` 節がない場合は `null`）
- `else if` は `else` フィールドに `IfStmt` をネストすることで表現する

### MemberAccess

`this.フィールド名` へのアクセスを表すノード。フィールドの参照・代入の両方で使用される。

```json
// this.bits の参照
{
    "type": "MemberAccess",
    "resolvedType": "_m32",
    "receiver": { "type": "Identifier", "name": "this", "resolvedType": "i32" },
    "member": "bits"
}
```

**代入時（`this.bits = raw`）**

```json
{
    "type": "Assign",
    "target": {
        "type": "MemberAccess",
        "resolvedType": "_m32",
        "receiver": { "type": "Identifier", "name": "this", "resolvedType": "i32" },
        "member": "bits"
    },
    "value": { "type": "Identifier", "name": "raw", "resolvedType": "_m32" }
}
```

### ReturnStmt

```json
{
    "type": "ReturnStmt",
    "value": { "type": "Identifier", "name": "result", "resolvedType": "i32" }
}
```

### BreakStmt

```json
{ "type": "BreakStmt" }
```

### マルチスレッドノード

```json
{ "type": "ThreadSpawn", "resolvedType": "_m64", "fnName": "searchAlphaBeta", "args": [...] }
{ "type": "ThreadJoin", "resolvedType": "void", "threadId": { ... } }
{ "type": "ThreadPoolCreate", "resolvedType": "_m64", "size": { ... } }
{ "type": "ThreadPoolSubmit", "resolvedType": "void", "pool": { ... }, "fnName": "worker", "args": [...] }
{ "type": "ThreadPoolWait", "resolvedType": "void", "pool": { ... } }
{ "type": "ThreadPoolDestroy", "resolvedType": "void", "pool": { ... } }
{ "type": "MutexCreate", "resolvedType": "_m64" }
{ "type": "MutexLock", "resolvedType": "void", "mutexId": { ... } }
{ "type": "MutexUnlock", "resolvedType": "void", "mutexId": { ... } }
{ "type": "CondVarCreate", "resolvedType": "_m64" }
{ "type": "CondVarWait", "resolvedType": "void", "condVar": { ... }, "mutexId": { ... } }
{ "type": "CondVarSignal", "resolvedType": "void", "condVar": { ... } }
{ "type": "CondVarBroadcast", "resolvedType": "void", "condVar": { ... } }
{ "type": "AtomicLoad", "resolvedType": "_m32", "ptr": { ... } }
{ "type": "AtomicStore", "resolvedType": "void", "ptr": { ... }, "value": { ... } }
{ "type": "AtomicCas", "resolvedType": "_m32", "ptr": { ... }, "expected": { ... }, "desired": { ... } }
{ "type": "AtomicFetchAdd", "resolvedType": "_m32", "ptr": { ... }, "value": { ... } }
{ "type": "AtomicFetchSub", "resolvedType": "_m32", "ptr": { ... }, "value": { ... } }
```

- `ThreadSpawn` / `ThreadPoolSubmit` の `fnName` は文字列（評価時に関数名として解決される）
- `args` は式ノードの配列
- スレッドID・プールID・ミューテックスID・条件変数IDはすべて `_m64` で表現される

### RawLiteral

```json
// 数値リテラル
{ "type": "RawLiteral", "kind": "int", "value": 10 }

// 文字リテラル
{ "type": "RawLiteral", "kind": "char", "value": 104 }
```

---

## 6. 文字列リテラルの展開

文字列リテラルはフロントエンドが `Array<u32>` のインスタンス化へ展開済みの状態で出力される。

```json
// "hi" の展開例
{
    "type": "NewExpr",
    "resolvedType": "Array<u32>",
    "args": [],
    "elements": [
        { "type": "RawLiteral", "kind": "char", "value": 104 },
        { "type": "RawLiteral", "kind": "char", "value": 105 }
    ]
}
```

---

## 7. 完全な出力例

以下のmozaicScriptコードに対するASTの出力例を示す。

**入力（`main.moz`）**

```typescript
import "./core.moc" as *;

public function add(a: i32, b: i32): i32 {
    return a + b;
}
```

**出力（JSON AST）**

```json
{
    "mozaicScript": "0.2.3",
    "nodes": [
        {
            "type": "ImportDecl",
            "path": "./core.moc",
            "namespace": null
        },
        {
            "type": "FunctionDecl",
            "name": "add",
            "access": "public",
            "typeParams": [],
            "params": [
                { "name": "a", "resolvedType": "i32" },
                { "name": "b", "resolvedType": "i32" }
            ],
            "returnType": "i32",
            "body": [
                {
                    "type": "ReturnStmt",
                    "value": {
                        "type": "MethodCall",
                        "resolvedType": "i32",
                        "receiver": {
                            "type": "Identifier",
                            "name": "a",
                            "resolvedType": "i32"
                        },
                        "method": "operator+",
                        "args": [
                            {
                                "type": "Identifier",
                                "name": "b",
                                "resolvedType": "i32"
                            }
                        ]
                    }
                }
            ]
        }
    ]
}
```
