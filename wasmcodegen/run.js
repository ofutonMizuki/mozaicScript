// wasmcodegen/run.js — mozaicScript が生成した .wasm を実行する Node ローダー
// 使用法: node wasmcodegen/run.js <file.wasm>
//
// モジュールは線形メモリを export し、I/O・超越関数を env から import する。
// 文字列は Array<u32>（各文字を u32 で格納）。ptr はワードインデックス
// (= byte/4) なので、ホスト側はバイトアドレス ptr*4 から len 個の u32 を読む。

"use strict";
const fs = require("fs");

const file = process.argv[2];
if (!file) {
    console.error("Usage: node wasmcodegen/run.js <file.wasm>");
    process.exit(1);
}

const bytes = fs.readFileSync(file);
let mem = null;

function readStr(ptrWord, len) {
    const u32 = new Uint32Array(mem.buffer, ptrWord * 4, len);
    let s = "";
    for (let i = 0; i < len; i++) s += String.fromCodePoint(u32[i]);
    return s;
}

const env = {
    stdout_write: (p, l) => process.stdout.write(readStr(p, l)),
    stderr_write: (p, l) => process.stderr.write(readStr(p, l)),
    panic: (p, l) => { process.stderr.write("[PANIC] " + readStr(p, l) + "\n"); process.exit(1); },
    sin: Math.sin, cos: Math.cos, tan: Math.tan, exp: Math.exp, log: Math.log, atan: Math.atan,
    pow: Math.pow, atan2: Math.atan2, fmod: (a, b) => a % b,
};

WebAssembly.instantiate(bytes, { env })
    .then(({ instance }) => {
        mem = instance.exports.memory;
        instance.exports.main();
    })
    .catch((e) => {
        process.stderr.write(String((e && e.stack) || e) + "\n");
        process.exit(1);
    });
