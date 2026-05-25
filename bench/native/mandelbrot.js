// native JS baseline — speed_mandelbrot.moz と同一
// f32 セマンティクスを再現するため各演算を Math.fround で丸める。
const f = Math.fround;
const W = 220, H = 150, MAXIT = 120;
let inside = 0;
for (let py = 0; py < H; py++) {
    const y0 = f(f(f(f(py) / f(H)) * 2) - 1);
    for (let px = 0; px < W; px++) {
        const x0 = f(f(f(f(px) / f(W)) * 3) - 2);
        let zx = 0, zy = 0, it = 0, escaped = false;
        while (it < MAXIT) {
            const xx = f(zx * zx), yy = f(zy * zy);
            if (f(xx + yy) > 4) { escaped = true; break; }
            const nzy = f(f(f(2 * zx) * zy) + y0);
            zx = f(f(xx - yy) + x0);
            zy = nzy;
            it++;
        }
        if (!escaped) inside++;
    }
}
console.log("mandelbrot inside pts = " + inside);
