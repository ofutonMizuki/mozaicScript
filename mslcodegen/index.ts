// mslcodegen/index.ts — CLI: <entry.moz>.gpu.json → <entry.moz>.metal
//
// 使用法:
//   ts-node mslcodegen/index.ts <entry.moz> [output.metal]
//
// 入力は compiler が出力した <entry.moz>.gpu.json。

import * as fs from "fs";
import * as path from "path";
import { emitMsl } from "./codegen";

const args = process.argv.slice(2);
if (args.length === 0) {
    console.error("Usage: ts-node mslcodegen/index.ts <entry.moz> [output.metal]");
    process.exit(1);
}

const entry = path.resolve(args[0]);
const outArg = args[1];
const gpuJsonPath = entry + ".gpu.json";

if (!fs.existsSync(gpuJsonPath)) {
    console.error(`GPU IR not found: ${gpuJsonPath}`);
    console.error(`Compile first with: ts-node compiler/index.ts ${args[0]}`);
    process.exit(1);
}

const mod = JSON.parse(fs.readFileSync(gpuJsonPath, "utf-8"));
const msl = emitMsl(mod);

const outPath = outArg ?? entry.replace(/\.moz$/, ".metal");
fs.writeFileSync(outPath, msl, "utf-8");
console.log(`  ✓  ${path.relative(process.cwd(), outPath)}`);
