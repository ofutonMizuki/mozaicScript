/* native C baseline — speed_collatz.moz と同一 */
#include <stdio.h>
#include <stdint.h>
int main(void) {
    int32_t maxSteps = 0, argmax = 0;
    for (uint32_t n = 1; n < 40000u; n++) {
        uint64_t v = n;
        int32_t steps = 0;
        while (v > 1) {
            if (v % 2 == 0) v /= 2; else v = v * 3 + 1;
            steps++;
        }
        if (steps > maxSteps) { maxSteps = steps; argmax = (int32_t)n; }
    }
    printf("max collatz steps (<40000) = %d\n", maxSteps);
    printf("argmax = %d\n", argmax);
    return 0;
}
