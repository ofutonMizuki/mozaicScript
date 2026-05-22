// codegen/index.ts — mozaicScript IR → C CLI
// 使用法: ts-node codegen/index.ts <entry.moz>
//
// エントリーファイルの *.ast.json を読み込み、C ソースを生成する。
// 依存 .ast.json は自動的に収集される。

import * as fs   from "fs";
import * as path from "path";
import { CCodegen } from "./codegen";

const args = process.argv.slice(2);
if (args.length === 0) {
    console.error("Usage: ts-node codegen/index.ts <entry.moz>");
    process.exit(1);
}

const entryMoz  = path.resolve(args[0]);
const outPath   = args[1] ?? entryMoz.replace(/\.(moz|moc)$/, ".c");
const baseDir   = path.dirname(entryMoz);

const gen = new CCodegen(baseDir);
gen.loadAST(entryMoz);

const cSource = gen.emit();
fs.writeFileSync(outPath, cSource, "utf-8");
console.log(`  ✓  ${path.relative(process.cwd(), outPath)}`);
