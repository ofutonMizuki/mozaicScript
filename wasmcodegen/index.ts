// wasmcodegen/index.ts — mozaicScript IR → WebAssembly (.wasm) CLI
// 使用法: ts-node wasmcodegen/index.ts <entry.moz> [output.wasm]
//
// エントリーファイルの *.ast.json (コンパイル済み) と依存 *.ast.json を読み込み、
// 単一の実行可能な WebAssembly モジュールを生成する。
// 生成した .wasm は `node wasmcodegen/run.js <output.wasm>` で実行可能。

import * as fs from "fs";
import * as path from "path";
import { WasmCodegen } from "./codegen";

const args = process.argv.slice(2);
if (args.length === 0) {
    console.error("Usage: ts-node wasmcodegen/index.ts <entry.moz> [output.wasm]");
    process.exit(1);
}

const entryMoz = path.resolve(args[0]);
const outPath = args[1] ?? entryMoz.replace(/\.(moz|moc)$/, ".wasm");

const gen = new WasmCodegen();
gen.loadAST(entryMoz);

const bytes = gen.emit();
fs.writeFileSync(outPath, bytes);
console.log(`  ✓  ${path.relative(process.cwd(), outPath)}`);
