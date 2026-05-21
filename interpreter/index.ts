import * as fs from "fs";
import * as nodePath from "path";
import { Evaluator } from "./evaluator";
import { PanicError } from "./builtins";

const args = process.argv.slice(2);
if (args.length === 0) {
    console.error("Usage: ts-node interpreter/index.ts <main.moz.ast.json>");
    process.exit(1);
}

const entryPath = nodePath.resolve(args[0]);

// エントリーポイントの .ast.json サフィックスを除いたパスを渡す
// 例: /path/to/main.moz.ast.json → /path/to/main.moz
const sourcePath = entryPath.endsWith(".ast.json")
    ? entryPath.slice(0, -".ast.json".length)
    : entryPath;

const evaluator = new Evaluator(nodePath.dirname(sourcePath));

try {
    evaluator.run(sourcePath);
} catch (e) {
    if (e instanceof PanicError) {
        console.error(e.message);
        process.exit(1);
    }
    throw e;
}
