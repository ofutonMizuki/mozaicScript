# wasmcodegen/

IR JSON → WebAssembly バイナリ変換バックエンド。外部アセンブラ不要でバイナリ `.wasm` を直接出力する。

## ファイル

| ファイル | 役割 |
|---|---|
| `encoder.ts` | 低レベルバイナリエンコーダ。LEB128 / `FuncBuilder`（命令ストリーム）/ `ModuleBuilder`（セクション組み立て）を実装 |
| `codegen.ts` | 変換本体。`loadAST()` で依存 `*.ast.json` を再帰収集し、`ModuleBuilder` を使って `.wasm` を生成 |
| `index.ts` | CLI エントリポイント |
| `run.js` | Node.js 実行ローダー。`env` インポート（`stdout_write` / `stderr_write` / `panic` / 超越関数）を提供 |

## 使い方

```bash
npx ts-node wasmcodegen/index.ts <entry.moz> [output.wasm]
node wasmcodegen/run.js <output.wasm>
```

## メモリモデルの注意点

- float は `i32`/`i64` にビットパターンで格納し、float 演算の直前に `reinterpret` する
- `malloc`/`__builtin_mem_*` のポインタはワードインデックス（byte/4）。仕様はバイトアドレスに統一済みだが実装は未追従（OPEN-QUESTIONS.md M2）
- `npm run build`（tsconfig）の型チェック対象外

