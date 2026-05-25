// native JS baseline — speed_collatz.moz と同一（値は < 2^53 なので Number で厳密）
let maxSteps = 0, argmax = 0;
for (let n = 1; n < 40000; n++) {
    let v = n, steps = 0;
    while (v > 1) {
        if (v % 2 === 0) v = v / 2; else v = v * 3 + 1;
        steps++;
    }
    if (steps > maxSteps) { maxSteps = steps; argmax = n; }
}
console.log("max collatz steps (<40000) = " + maxSteps);
console.log("argmax = " + argmax);
