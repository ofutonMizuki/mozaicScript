// mslcodegen/run.swift — MSL シェーダを Metal で実行するスタンドアロンランナー
//
// 使用法 (Mac):
//   swift mslcodegen/run.swift <entry.moz>
//
// 動作要件:
//   - macOS 10.13+
//   - Xcode (Metal フレームワーク利用)
//
// 動作:
//   1. <entry.moz>.gpu.json を読み GPU IR を取得 (workgroupSize, params)
//   2. <entry.moz>.metal を読みシェーダソースを取得
//   3. <entry.moz>.gpu.test.json を読みテストスペックを取得
//   4. MTLDevice 上で各カーネルをディスパッチし出力バッファを read back
//   5. 出力を stdout に JSON 形式で印字
//
// テストスペック JSON 形式 (wgslcodegen/run.js と共通):
//   {
//     "tests": [
//       { "kernel": "vecAdd",
//         "grid": [2, 1, 1],
//         "buffers": { "out": [0,0,...], "a": [1,1,...], "b": [2,2,...] },
//         "scalars": { "n": 8 },
//         "read": ["out"] }
//     ]
//   }

import Foundation
import Metal

guard CommandLine.arguments.count >= 2 else {
    print("Usage: swift mslcodegen/run.swift <entry.moz>")
    exit(1)
}

let entry      = CommandLine.arguments[1]
let gpuJsonPath = entry + ".gpu.json"
let mslPath    = (entry as NSString).replacingOccurrences(of: ".moz", with: ".metal")
let specPath   = entry + ".gpu.test.json"

guard let gpuJsonData = FileManager.default.contents(atPath: gpuJsonPath),
      let gpuJson = try? JSONSerialization.jsonObject(with: gpuJsonData) as? [String: Any],
      let kernels = gpuJson["kernels"] as? [[String: Any]] else {
    fputs("Failed to read GPU IR at \(gpuJsonPath)\n", stderr); exit(1)
}

guard let mslData = FileManager.default.contents(atPath: mslPath),
      let mslSource = String(data: mslData, encoding: .utf8) else {
    fputs("Failed to read MSL at \(mslPath)\n", stderr); exit(1)
}

guard let specData = FileManager.default.contents(atPath: specPath),
      let spec = try? JSONSerialization.jsonObject(with: specData) as? [String: Any],
      let tests = spec["tests"] as? [[String: Any]] else {
    fputs("Failed to read test spec at \(specPath)\n", stderr); exit(1)
}

guard let device = MTLCreateSystemDefaultDevice() else {
    fputs("No Metal device available\n", stderr); exit(1)
}
let commandQueue = device.makeCommandQueue()!
let library = try! device.makeLibrary(source: mslSource, options: nil)

var allResults = [String: Any]()

for test in tests {
    guard let kernelName = test["kernel"] as? String,
          let kernelIR = kernels.first(where: { ($0["name"] as? String) == kernelName }),
          let params = kernelIR["params"] as? [[String: Any]] else { continue }

    guard let fn = library.makeFunction(name: kernelName) else {
        fputs("kernel \(kernelName) not found in MSL library\n", stderr); continue
    }
    let pipeline = try! device.makeComputePipelineState(function: fn)

    let buffersIn = test["buffers"] as? [String: [Any]] ?? [:]
    let scalarsIn = test["scalars"] as? [String: Any] ?? [:]
    let grid      = test["grid"]    as? [Int]         ?? [1, 1, 1]
    let read      = test["read"]    as? [String]      ?? []

    var mtlBuffers = [String: MTLBuffer]()

    for p in params {
        guard let name = p["name"] as? String,
              let type = p["type"] as? String,
              let binding = p["binding"] as? Int else { continue }

        if type.hasPrefix("ptr<") {
            let data = buffersIn[name] ?? []
            let elem = String(type.dropFirst(4).dropLast())
            let byteSize = elem == "f64" || elem == "i64" || elem == "u64" ? 8 : 4
            let byteLen = data.count * byteSize
            let buf = device.makeBuffer(length: max(byteLen, 16), options: .storageModeShared)!
            // ホストデータを書き込む
            writeArray(buf: buf, elem: elem, data: data)
            mtlBuffers[name] = buf
        } else {
            // スカラーは小さい buffer を作成
            let v = scalarsIn[name] ?? 0
            let buf = device.makeBuffer(length: 8, options: .storageModeShared)!
            writeScalar(buf: buf, type: type, v: v)
            mtlBuffers[name] = buf
        }
    }

    let cmdBuf = commandQueue.makeCommandBuffer()!
    let enc = cmdBuf.makeComputeCommandEncoder()!
    enc.setComputePipelineState(pipeline)

    for p in params {
        let name = p["name"] as! String
        let binding = p["binding"] as! Int
        if let buf = mtlBuffers[name] {
            enc.setBuffer(buf, offset: 0, index: binding)
        }
    }

    // workgroupSize と grid
    let wgs = kernelIR["workgroupSize"] as? [Int] ?? [64, 1, 1]
    enc.dispatchThreadgroups(
        MTLSize(width: grid[0], height: grid[1], depth: grid[2]),
        threadsPerThreadgroup: MTLSize(width: wgs[0], height: wgs[1], depth: wgs[2])
    )
    enc.endEncoding()
    cmdBuf.commit()
    cmdBuf.waitUntilCompleted()

    // 出力 read back
    var out = [String: [Any]]()
    for name in read {
        guard let buf = mtlBuffers[name],
              let pIR = params.first(where: { ($0["name"] as? String) == name }),
              let type = pIR["type"] as? String,
              type.hasPrefix("ptr<") else { continue }
        let elem = String(type.dropFirst(4).dropLast())
        let inSpec = buffersIn[name] ?? []
        let count = inSpec.count
        out[name] = readArray(buf: buf, elem: elem, count: count)
    }
    allResults[kernelName] = out
}

let outData = try! JSONSerialization.data(withJSONObject: allResults, options: [.prettyPrinted])
FileHandle.standardOutput.write(outData)
FileHandle.standardOutput.write("\n".data(using: .utf8)!)


// ── helpers ──

func writeArray(buf: MTLBuffer, elem: String, data: [Any]) {
    let ptr = buf.contents()
    switch elem {
        case "f32":
            let p = ptr.bindMemory(to: Float32.self, capacity: data.count)
            for (i, v) in data.enumerated() { p[i] = Float32((v as? Double) ?? (v as? Float).map(Double.init) ?? 0.0) }
        case "i32":
            let p = ptr.bindMemory(to: Int32.self, capacity: data.count)
            for (i, v) in data.enumerated() { p[i] = Int32((v as? Int) ?? 0) }
        case "u32":
            let p = ptr.bindMemory(to: UInt32.self, capacity: data.count)
            for (i, v) in data.enumerated() { p[i] = UInt32((v as? Int) ?? 0) }
        default: break
    }
}

func readArray(buf: MTLBuffer, elem: String, count: Int) -> [Any] {
    let ptr = buf.contents()
    var arr: [Any] = []
    switch elem {
        case "f32":
            let p = ptr.bindMemory(to: Float32.self, capacity: count)
            for i in 0..<count { arr.append(Double(p[i])) }
        case "i32":
            let p = ptr.bindMemory(to: Int32.self, capacity: count)
            for i in 0..<count { arr.append(Int(p[i])) }
        case "u32":
            let p = ptr.bindMemory(to: UInt32.self, capacity: count)
            for i in 0..<count { arr.append(Int(p[i])) }
        default: break
    }
    return arr
}

func writeScalar(buf: MTLBuffer, type: String, v: Any) {
    let ptr = buf.contents()
    switch type {
        case "f32":
            ptr.bindMemory(to: Float32.self, capacity: 1)[0] = Float32((v as? Double) ?? 0.0)
        case "i32":
            ptr.bindMemory(to: Int32.self, capacity: 1)[0] = Int32((v as? Int) ?? 0)
        default:  // u32 など
            ptr.bindMemory(to: UInt32.self, capacity: 1)[0] = UInt32((v as? Int) ?? 0)
    }
}
