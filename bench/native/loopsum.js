// native JS baseline — speed_loopsum.moz と同一
let sum = 0;
for (let i = 0; i < 5000000; i++) sum = (sum + i) >>> 0;
console.log("loopsum = " + (sum | 0));
