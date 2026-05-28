// wasmcodegen/run.js — mozaicScript が生成した .wasm を実行する Node ローダー
// 使用法: node wasmcodegen/run.js <file.wasm>
//
// モジュールは線形メモリを export し、I/O・超越関数・GPU エミュレーションを env から import する。
// 文字列は Array<u32>（各文字を u32 で格納）。ptr はワードインデックス
// (= byte/4) なので、ホスト側はバイトアドレス ptr*4 から len 個の u32 を読む。
//
// GPU エミュレーション (CPU 同期実行) は env として実装し、
// kernel 関数自身は WASM 側に `gpu_kernel_<idx>` の名前で export される。
// env.gpu_dispatch から instance.exports.gpu_kernel_<idx>(...args) を呼び返す。

"use strict";
const fs = require("fs");

const file = process.argv[2];
if (!file) {
    console.error("Usage: node wasmcodegen/run.js <file.wasm>");
    process.exit(1);
}

const bytes = fs.readFileSync(file);
let mem = null;
let memU8 = null;
let memI32 = null;
let memF32 = null;
let instance = null;

function refreshViews() {
    memU8 = new Uint8Array(mem.buffer);
    memI32 = new Int32Array(mem.buffer);
    memF32 = new Float32Array(mem.buffer);
}

function readStr(ptrWord, len) {
    const u32 = new Uint32Array(mem.buffer, ptrWord * 4, len);
    let s = "";
    for (let i = 0; i < len; i++) s += String.fromCodePoint(u32[i]);
    return s;
}

// ── GPU エミュレーション state ──
const gpuKernels = [];   // [{ wgx, wgy, wgz }]
const gpuBuffers = [];   // [{ addr, byteSize }] (index 0 unused)
const gpuArgsList = [];  // [Array of (number|bigint)] (index 0 unused)
gpuBuffers.push(null);
gpuArgsList.push(null);
const gpuCtx = { gix:0, giy:0, giz:0, lix:0, liy:0, liz:0, wix:0, wiy:0, wiz:0, wgx:1 };

function wasmAlloc(byteSize) {
    // WASM 側 _ms_malloc は word index を返す (Ptr<T>.addr と同じ表現)
    return instance.exports._ms_malloc(byteSize|0);
}

const env = {
    stdout_write: (p, l) => process.stdout.write(readStr(p, l)),
    stderr_write: (p, l) => process.stderr.write(readStr(p, l)),
    panic: (p, l) => { process.stderr.write("[PANIC] " + readStr(p, l) + "\n"); process.exit(1); },
    sin: Math.sin, cos: Math.cos, tan: Math.tan, exp: Math.exp, log: Math.log, atan: Math.atan,
    pow: Math.pow, atan2: Math.atan2, fmod: (a, b) => a % b,

    // ── GPU エミュレーション env imports ──
    gpu_is_available: () => 1,
    gpu_buffer_create: (byteSizeBig) => {
        const byteSize = Number(byteSizeBig);
        const addr = wasmAlloc(byteSize);
        const h = gpuBuffers.length;
        gpuBuffers.push({ addr, byteSize });
        return BigInt(h);
    },
    gpu_buffer_map_write: (hBig) => gpuBuffers[Number(hBig)].addr | 0,
    gpu_buffer_map_read:  (hBig) => gpuBuffers[Number(hBig)].addr | 0,
    gpu_buffer_unmap:     (_hBig) => {},
    gpu_buffer_byte_size: (hBig) => BigInt(gpuBuffers[Number(hBig)].byteSize),
    gpu_buffer_free:      (_hBig) => {},

    gpu_kernel_handle:    (idx) => BigInt((idx|0) + 1),
    gpu_kernel_wgx:       (hBig) => gpuKernels[Number(hBig) - 1].wgx,
    gpu_kernel_wgy:       (hBig) => gpuKernels[Number(hBig) - 1].wgy,
    gpu_kernel_wgz:       (hBig) => gpuKernels[Number(hBig) - 1].wgz,
    gpu_kernel_name:      (_hBig) => 0,  // stub: returns Array<u32>* (byte addr); not used by tests

    gpu_args_create: () => { const h = gpuArgsList.length; gpuArgsList.push([]); return BigInt(h); },
    gpu_args_push_buffer: (hBig, bufBig) => {
        const buf = gpuBuffers[Number(bufBig)];
        gpuArgsList[Number(hBig)].push(buf.addr | 0);
    },
    gpu_args_push_i32: (hBig, v) => gpuArgsList[Number(hBig)].push(v | 0),
    gpu_args_push_i64: (hBig, vBig) => gpuArgsList[Number(hBig)].push(vBig),
    gpu_args_count:    (hBig) => gpuArgsList[Number(hBig)].length | 0,
    gpu_args_clear:    (hBig) => { gpuArgsList[Number(hBig)] = []; },

    gpu_sync: () => {},
    gpu_flush: () => {},

    gpu_register_kernel: (idx, wgx, wgy, wgz) => {
        gpuKernels[idx|0] = { wgx: wgx|0, wgy: wgy|0, wgz: wgz|0 };
    },

    gpu_dispatch: (kBig, aBig, gx, gy, gz) => {
        const kIdx = Number(kBig) - 1;
        const k = gpuKernels[kIdx];
        if (!k) throw new Error(`Unknown gpu kernel handle ${kBig}`);
        const kfn = instance.exports[`gpu_kernel_${kIdx}`];
        if (!kfn) throw new Error(`gpu kernel export gpu_kernel_${kIdx} not found`);
        const args = gpuArgsList[Number(aBig)] ?? [];
        const prev = Object.assign({}, gpuCtx);
        gpuCtx.wgx = k.wgx;
        for (let wz = 0; wz < (gz|0); wz++)
        for (let wy = 0; wy < (gy|0); wy++)
        for (let wx = 0; wx < (gx|0); wx++) {
            gpuCtx.wix = wx; gpuCtx.wiy = wy; gpuCtx.wiz = wz;
            for (let lz = 0; lz < k.wgz; lz++)
            for (let ly = 0; ly < k.wgy; ly++)
            for (let lx = 0; lx < k.wgx; lx++) {
                gpuCtx.lix = lx; gpuCtx.liy = ly; gpuCtx.liz = lz;
                gpuCtx.gix = wx * k.wgx + lx;
                gpuCtx.giy = wy * k.wgy + ly;
                gpuCtx.giz = wz * k.wgz + lz;
                kfn(...args);
            }
        }
        Object.assign(gpuCtx, prev);
    },

    gpu_tid_gix: () => gpuCtx.gix, gpu_tid_giy: () => gpuCtx.giy, gpu_tid_giz: () => gpuCtx.giz,
    gpu_tid_lix: () => gpuCtx.lix, gpu_tid_liy: () => gpuCtx.liy, gpu_tid_liz: () => gpuCtx.liz,
    gpu_tid_wix: () => gpuCtx.wix, gpu_tid_wiy: () => gpuCtx.wiy, gpu_tid_wiz: () => gpuCtx.wiz,
    gpu_tid_wgx: () => gpuCtx.wgx,

    // GPU アトミック: シングルスレッドで普通の RMW (ptr は word index)
    gpu_atomic_add_u32:   (addr, v) => { const o = memI32[addr]>>>0; memI32[addr] = (o + (v>>>0))>>>0; return o; },
    gpu_atomic_sub_u32:   (addr, v) => { const o = memI32[addr]>>>0; memI32[addr] = (o - (v>>>0))>>>0; return o; },
    gpu_atomic_min_u32:   (addr, v) => { const o = memI32[addr]>>>0; const n = v>>>0; memI32[addr] = n<o?n:o; return o; },
    gpu_atomic_max_u32:   (addr, v) => { const o = memI32[addr]>>>0; const n = v>>>0; memI32[addr] = n>o?n:o; return o; },
    gpu_atomic_cas_u32:   (addr, e, d) => { const o = memI32[addr]>>>0; if (o === (e>>>0)) memI32[addr] = d>>>0; return o; },
    gpu_atomic_load_u32:  (addr) => memI32[addr]>>>0,
    gpu_atomic_store_u32: (addr, v) => { memI32[addr] = v>>>0; },
    gpu_atomic_add_i32:   (addr, v) => { const o = memI32[addr]|0; memI32[addr] = (o + (v|0))|0; return o; },
    gpu_atomic_sub_i32:   (addr, v) => { const o = memI32[addr]|0; memI32[addr] = (o - (v|0))|0; return o; },
    gpu_atomic_min_i32:   (addr, v) => { const o = memI32[addr]|0; const n = v|0; memI32[addr] = n<o?n:o; return o; },
    gpu_atomic_max_i32:   (addr, v) => { const o = memI32[addr]|0; const n = v|0; memI32[addr] = n>o?n:o; return o; },
    gpu_atomic_cas_i32:   (addr, e, d) => { const o = memI32[addr]|0; if (o === (e|0)) memI32[addr] = d|0; return o; },
    gpu_atomic_load_i32:  (addr) => memI32[addr]|0,
    gpu_atomic_store_i32: (addr, v) => { memI32[addr] = v|0; },

    // f32 を i32 bits 経由で受け渡す
    gpu_fma: (aBits, bBits, cBits) => {
        const a = bitsToF32(aBits|0), b = bitsToF32(bBits|0), c = bitsToF32(cBits|0);
        return f32ToBits(Math.fround(a * b + c));
    },
    gpu_dot_f32x4: (aAddr, bAddr) => {
        const a = aAddr|0, b = bAddr|0;
        let s = 0;
        for (let i = 0; i < 4; i++) {
            s = Math.fround(s + Math.fround(bitsToF32(memI32[a + i]) * bitsToF32(memI32[b + i])));
        }
        return f32ToBits(s);
    },
};

const _f32Buf = new ArrayBuffer(4);
const _f32I = new Int32Array(_f32Buf);
const _f32F = new Float32Array(_f32Buf);
function bitsToF32(b) { _f32I[0] = b|0; return _f32F[0]; }
function f32ToBits(f) { _f32F[0] = Math.fround(f); return _f32I[0]; }

WebAssembly.instantiate(bytes, { env })
    .then((res) => {
        instance = res.instance;
        mem = instance.exports.memory;
        refreshViews();
        instance.exports.main();
    })
    .catch((e) => {
        process.stderr.write(String((e && e.stack) || e) + "\n");
        process.exit(1);
    });
