// jscodegen/index.ts — mozaicScript IR → JavaScript CLI
// 使用法: ts-node jscodegen/index.ts <entry.moz> [output.js]
//
// エントリーファイルの *.ast.json (コンパイル済み) を読み込み、
// 実行可能な JavaScript ファイルを生成する。
// 生成した JS は `node <output.js>` で直接実行可能。

import * as fs   from "fs";
import * as path from "path";
import { JSCodegen } from "./codegen";

const args = process.argv.slice(2);
if (args.length === 0) {
    console.error("Usage: ts-node jscodegen/index.ts <entry.moz> [output.js]");
    process.exit(1);
}

const entryMoz = path.resolve(args[0]);
const outPath  = args[1] ?? entryMoz.replace(/\.(moz|moc)$/, ".js");

const gen = new JSCodegen();
gen.loadAST(entryMoz);

const jsSource = gen.emit();
fs.writeFileSync(outPath, jsSource, "utf-8");
console.log(`  ✓  ${path.relative(process.cwd(), outPath)}`);
