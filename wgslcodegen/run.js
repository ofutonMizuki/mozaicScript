// wgslcodegen/run.js — WGSL シェーダを WebGPU で実行するスタンドアロンランナー
//
// 使用法:
//   node wgslcodegen/run.js <entry.moz>
//
// 動作要件 (いずれか 1 つ):
//   - Deno 1.39+        (WebGPU をネイティブサポート)
//   - Chrome/Edge       (script として読み込み)
//   - Node + webgpu npm パッケージ (npm i webgpu) — Linux/Mac/Windows のいずれか
//
// 動作:
//   1. <entry.moz>.gpu.json を読み GPU IR を取得 (workgroupSize, params)
//   2. <entry.moz>.wgsl を読みシェーダソースを取得
//   3. JSON で記述された "テストスペック" (<entry.moz>.gpu.test.json) を読む
//      ファイル形式は本ファイル末尾の例参照
//   4. WebGPU device に各カーネルをディスパッチし出力バッファを read back
//   5. 出力を stdout に JSON 形式で印字
//
// なお mozaicScript の通常コード生成 (JS/C/WASM) は本ランナーとは独立で、
// それらは CPU エミュレーションを継続使用する。本ランナーは「生成された WGSL が
// 実際の WebGPU 上で正しく動くか」を確認するための差分テストの土台。

"use strict";
const fs = require("fs");
const path = require("path");

const arg = process.argv[2];
if (!arg) {
    console.error("Usage: node wgslcodegen/run.js <entry.moz>");
    process.exit(1);
}

const entry      = path.resolve(arg);
const gpuJsonP   = entry + ".gpu.json";
const wgslP      = entry.replace(/\.moz$/, ".wgsl");
const testSpecP  = entry + ".gpu.test.json";

if (!fs.existsSync(gpuJsonP)) { console.error("missing", gpuJsonP); process.exit(1); }
if (!fs.existsSync(wgslP))    { console.error("missing", wgslP);    process.exit(1); }
if (!fs.existsSync(testSpecP)){
    console.error("missing test spec", testSpecP);
    console.error("create one (see wgslcodegen/run.js comments at EOF)");
    process.exit(1);
}

const mod  = JSON.parse(fs.readFileSync(gpuJsonP, "utf-8"));
const wgsl = fs.readFileSync(wgslP, "utf-8");
const spec = JSON.parse(fs.readFileSync(testSpecP, "utf-8"));

async function getGPU() {
    if (typeof navigator !== "undefined" && navigator.gpu) return navigator.gpu;
    // Node + webgpu npm パッケージのフォールバック
    try {
        const w = require("webgpu");
        return w.gpu ?? w.default?.gpu ?? w;
    } catch (e) {
        console.error("WebGPU is unavailable. Install via `npm i webgpu` or run on a WebGPU-capable runtime (Deno 1.39+, Chrome).");
        process.exit(1);
    }
}

async function main() {
    const gpu = await getGPU();
    const adapter = await gpu.requestAdapter();
    if (!adapter) { console.error("No WebGPU adapter"); process.exit(1); }
    const device = await adapter.requestDevice();
    const shader = device.createShaderModule({ code: wgsl });

    const results = {};

    for (const test of spec.tests) {
        const kernel = mod.kernels.find(k => k.name === test.kernel);
        if (!kernel) { console.error("kernel not found:", test.kernel); continue; }

        // バッファとスカラーをセットアップ
        const buffers = {};      // name → GPUBuffer
        const scalarsObj = {};   // 全スカラーを 1 つの uniform buffer にまとめる
        const bindings = [];

        for (const p of kernel.params) {
            if (p.type.startsWith("ptr<")) {
                const data = test.buffers[p.name];
                if (!data) { console.error(`buffer ${p.name} not provided`); process.exit(1); }
                const elem = p.type.slice(4, -1);
                const byteSize = elem === "f64" || elem === "i64" || elem === "u64" ? 8 : 4;
                const buf = device.createBuffer({
                    size: data.length * byteSize,
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
                });
                const ta = makeTypedArray(elem, data.length);
                for (let i = 0; i < data.length; i++) ta[i] = data[i];
                device.queue.writeBuffer(buf, 0, ta.buffer);
                buffers[p.name] = buf;
                bindings.push({ binding: p.binding, resource: { buffer: buf } });
            } else {
                scalarsObj[p.name] = test.scalars[p.name];
            }
        }

        // uniform buffer for scalars
        if (Object.keys(scalarsObj).length > 0) {
            // 4byte 整数/浮動小数点を直列化 (WGSL struct のレイアウトに合わせる)
            const scalarParams = kernel.params.filter(p => !p.type.startsWith("ptr<"));
            const buf = new ArrayBuffer(Math.max(scalarParams.length * 4, 16));
            const dv = new DataView(buf);
            scalarParams.forEach((p, i) => {
                const v = scalarsObj[p.name];
                if (p.type === "f32") dv.setFloat32(i * 4, v, true);
                else if (p.type === "i32") dv.setInt32(i * 4, v, true);
                else dv.setUint32(i * 4, v, true);
            });
            const ubo = device.createBuffer({
                size: buf.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
            device.queue.writeBuffer(ubo, 0, buf);
            const maxB = Math.max(...kernel.params.map(p => p.binding));
            bindings.push({ binding: maxB + 1, resource: { buffer: ubo } });
        }

        // pipeline
        const pipeline = device.createComputePipeline({
            layout: "auto",
            compute: { module: shader, entryPoint: test.kernel },
        });
        const bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: bindings,
        });

        const enc = device.createCommandEncoder();
        const pass = enc.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        const [gx, gy, gz] = test.grid ?? [1, 1, 1];
        pass.dispatchWorkgroups(gx, gy, gz);
        pass.end();

        // 出力バッファを read back
        const readBuffers = {};
        for (const outName of test.read ?? []) {
            const src = buffers[outName];
            const rb = device.createBuffer({
                size: src.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
            });
            enc.copyBufferToBuffer(src, 0, rb, 0, src.size);
            readBuffers[outName] = rb;
        }
        device.queue.submit([enc.finish()]);

        const out = {};
        for (const [name, rb] of Object.entries(readBuffers)) {
            await rb.mapAsync(GPUMapMode.READ);
            // 結果型は対応するカーネル param から決定
            const p = kernel.params.find(pp => pp.name === name);
            const elem = p.type.slice(4, -1);
            const ta = makeTypedArray(elem, rb.size / 4);
            ta.set(new (ta.constructor)(rb.getMappedRange()));
            out[name] = Array.from(ta);
            rb.unmap();
        }
        results[test.kernel] = out;
    }

    process.stdout.write(JSON.stringify(results, null, 2) + "\n");
}

function makeTypedArray(elem, n) {
    switch (elem) {
        case "f32": return new Float32Array(n);
        case "f64": return new Float64Array(n);
        case "i32": return new Int32Array(n);
        case "u32": return new Uint32Array(n);
        case "i64": return new BigInt64Array(n);
        case "u64": return new BigUint64Array(n);
        default:    return new Int32Array(n);
    }
}

main().catch(e => { console.error(e); process.exit(1); });

/* テストスペック JSON の例 (<entry.moz>.gpu.test.json):
{
  "tests": [
    {
      "kernel": "vecAdd",
      "grid": [2, 1, 1],
      "buffers": {
        "out": [0, 0, 0, 0, 0, 0, 0, 0],
        "a":   [1, 1, 1, 1, 1, 1, 1, 1],
        "b":   [2, 2, 2, 2, 2, 2, 2, 2]
      },
      "scalars": { "n": 8 },
      "read": ["out"]
    }
  ]
}
*/
