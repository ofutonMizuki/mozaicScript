// native JS baseline — speed_matrix.moz と同一（u32 乗算は Math.imul で一致）
const N = 90;
const lcg = s => (Math.imul(s, 1664525) + 1013904223) >>> 0;
const A = new Int32Array(N * N), B = new Int32Array(N * N), C = new Int32Array(N * N);
let s = 7;
for (let i = 0; i < N * N; i++) {
    s = lcg(s); A[i] = s % 10;
    s = lcg(s); B[i] = s % 10;
}
for (let row = 0; row < N; row++)
    for (let col = 0; col < N; col++) {
        let acc = 0;
        for (let k = 0; k < N; k++) acc += A[row * N + k] * B[k * N + col];
        C[row * N + col] = acc;
    }
let trace = 0;
for (let i = 0; i < N; i++) trace += C[i * N + i];
console.log("matrix trace = " + trace);
