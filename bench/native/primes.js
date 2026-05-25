// native JS baseline — speed_primes.moz と同一（エラトステネスの篩）
const N = 500000;
const sieve = new Int32Array(N);
sieve[0] = 1; sieve[1] = 1;
for (let p = 2; p * p < N; p++)
    if (!sieve[p])
        for (let m = p * p; m < N; m += p) sieve[m] = 1;
let c = 0;
for (let i = 2; i < N; i++) if (!sieve[i]) c++;
console.log("primes < 500000 = " + c);
