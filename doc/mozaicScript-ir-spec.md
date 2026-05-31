# 📄 mozaicScript 中間表現仕様書 (IR Specification)

本仕様書は mozaicScript 言語仕様書に基づき、フロントエンドが出力するJSON形式の中間表現（AST）の仕様を定義する。

---

## 1. 基本方針

- フォーマット：JSON
- 演算子オーバーロード・`if`/`while`/`<=`/`>=` の脱糖済み
- 型チェック済み（すべての式ノードに `resolvedType` を付与）
- バックエンドはこのJSONのみをインプットとして動作しなければならない（**MUST**）
- バックエンドは `resolvedType` を信頼してよく、独自に型推論を行う必要はない

> **注意:** 所有権・借用システムに関連する拡張（`BorrowExpr`ノードや`isMut`フィールド等）の詳細については、「[mozaicScript 所有権・借用システム拡張追加仕様書](mozaicScript-ownership-spec.md)」を参照すること。

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
| 式 | `MethodCall`, `NewExpr`, `Identifier`, `Intrinsic`, `Assign`, `MemberAccess`, `BorrowExpr` |
| 文 | `IfStmt`, `ElseStmt`, `WhileStmt`, `ForStmt`, `ReturnStmt`, `BreakStmt`, `BlockStmt` |
| リテラル | `RawLiteral` |

`BorrowExpr` および `FunctionDecl.isMut` フィールドは所有権・借用システム拡張で導入された（**MUST**）。詳細仕様は所有権・借用システム拡張追加仕様書§5 を参照。

> スレッド/ミューテックス/条件変数/アトミックなどの並行プリミティブは専用の IR ノードを持たず、コアライブラリ (`.moc`) のクラスメソッド経由で `Intrinsic`（`__builtin_thread_*`, `__builtin_mutex_*`, `__builtin_condvar_*`, `__builtin_atomic_*32/64`, `__builtin_atomic_fence`）として出力される。各バックエンドはこれら `Intrinsic` をネイティブ同期プリミティブに lower する。

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
    "isMut": false,
    "typeParams": [],
    "params": [
        { "name": "a", "resolvedType": "i32" },
        { "name": "b", "resolvedType": "i32" }
    ],
    "returnType": "Result<i32>",
    "body": [...]
}
```

`isMut`（boolean、**MUST**）は所有権・借用システム拡張で導入されたフィールド。`mut` 修飾子が付与されたメソッドおよび関数では `true`、それ以外は `false`。詳細は所有権・借用システム拡張追加仕様書§5.1 を参照。

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

### BorrowExpr

明示的な借用演算子 `&` および `&mut` を表現する式ノード（所有権・借用システム拡張§5.2 で導入）。

```json
{
    "type": "BorrowExpr",
    "isMut": true,
    "expr": {
        "type": "Identifier",
        "name": "a",
        "resolvedType": "i32"
    },
    "resolvedType": "&mut i32"
}
```

| フィールド | 型 | 説明 |
| --- | --- | --- |
| `type` | string | 固定値 `"BorrowExpr"` |
| `isMut` | boolean | `&mut` の場合は `true`、`&` の場合は `false` |
| `expr` | ASTNode | 借用対象となる式（通常は `Identifier` または `MemberAccess`） |
| `resolvedType` | string | 単一化・解決済みの完全な参照型名（`"&T"` または `"&mut T"`） |

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

### BlockStmt

裸ブロック `{ ... }` によって導入されるスコープを表すノード。`body` 内で宣言された変数は当該ブロックに閉じたスコープを持つ。

```json
{
    "type": "BlockStmt",
    "body": [...]
}
```

### 並行プリミティブ（IR ノードなし）

スレッド、ミューテックス、条件変数、アトミック操作は IR ノードとしては表現されず、コアライブラリのクラスメソッド経由で `Intrinsic` ノード（`__builtin_*`）として lower される。具体的には:

- スレッド: `__builtin_thread_spawn(fnName, args) -> _m64`, `__builtin_thread_join(id)`
- スレッドプール: `__builtin_threadpool_create(size) -> _m64`, `__builtin_threadpool_submit(pool, fnName, args)`, `__builtin_threadpool_wait(pool)`, `__builtin_threadpool_destroy(pool)`
- ミューテックス: `__builtin_mutex_create() -> _m64`, `__builtin_mutex_lock(id)`, `__builtin_mutex_unlock(id)`
- 条件変数: `__builtin_condvar_create() -> _m64`, `__builtin_condvar_wait(cv, mutex)`, `__builtin_condvar_signal(cv)`, `__builtin_condvar_broadcast(cv)`
- アトミック (32bit): `__builtin_atomic_load32(ptr, order)`, `__builtin_atomic_store32(ptr, val, order)`, `__builtin_atomic_cas32(ptr, exp, des, successOrder, failureOrder)`, `__builtin_atomic_fetch_add32(ptr, val, order)`, `__builtin_atomic_fetch_sub32(ptr, val, order)`
- アトミック (64bit): `__builtin_atomic_load64(ptr, order)`, `__builtin_atomic_store64(ptr, val, order)`, `__builtin_atomic_cas64(ptr, exp, des, successOrder, failureOrder)`, `__builtin_atomic_fetch_add64(ptr, val, order)`, `__builtin_atomic_fetch_sub64(ptr, val, order)`
- フェンス: `__builtin_atomic_fence(order)`

各バックエンドはこれら `Intrinsic` をネイティブの同期プリミティブ（pthread / Atomics / WASM 線形メモリ + シングルスレッド近似など）に lower する。

### RawLiteral

```json
// 数値リテラル
{ "type": "RawLiteral", "kind": "int", "value": 10 }

// 文字リテラル
{ "type": "RawLiteral", "kind": "char", "value": 104 }
```

---

## 6. 文字列リテラルの展開

文字列リテラルはフロントエンドが `Array<u32>` の生成 + `operator_set[]` メソッド呼び出しの連鎖に展開済みの状態で出力される。**正本はコアライブラリ仕様書§7.2** であり、本仕様はその脱糖結果としての JSON ノード列を示すに留まる。`NewExpr` ノードに専用の `elements` フィールドは存在しない（**MUST NOT**）。

```json
// "hi" の展開例（文 BlockStmt 内に 1 個の VarDecl + 2 個の Assign が並ぶ）
[
    {
        "type": "VarDecl",
        "name": "<tmp>",
        "resolvedType": "Array<u32>",
        "value": {
            "type": "NewExpr",
            "resolvedType": "Array<u32>",
            "args": [
                {
                    "type": "NewExpr",
                    "resolvedType": "u32",
                    "args": [{ "type": "RawLiteral", "kind": "int", "value": 2 }]
                }
            ]
        }
    },
    {
        "type": "Assign",
        "target": {
            "type": "MethodCall",
            "resolvedType": "void",
            "receiver": { "type": "Identifier", "name": "<tmp>", "resolvedType": "Array<u32>" },
            "method": "operator_set[]",
            "args": [
                { "type": "NewExpr", "resolvedType": "u32", "args": [{ "type": "RawLiteral", "kind": "int", "value": 0 }] },
                { "type": "NewExpr", "resolvedType": "u32", "args": [{ "type": "RawLiteral", "kind": "char", "value": 104 }] }
            ]
        },
        "value": null
    },
    {
        "type": "Assign",
        "target": {
            "type": "MethodCall",
            "resolvedType": "void",
            "receiver": { "type": "Identifier", "name": "<tmp>", "resolvedType": "Array<u32>" },
            "method": "operator_set[]",
            "args": [
                { "type": "NewExpr", "resolvedType": "u32", "args": [{ "type": "RawLiteral", "kind": "int", "value": 1 }] },
                { "type": "NewExpr", "resolvedType": "u32", "args": [{ "type": "RawLiteral", "kind": "char", "value": 105 }] }
            ]
        },
        "value": null
    }
]
```

- 旧仕様の `NewExpr.elements` フィールドは廃止（**MUST NOT**）。バックエンドは `elements` を読まないこと。
- 文字列リテラル展開以外の通常の `Array<T>` インスタンス化と完全に同じ AST 形になる。

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
