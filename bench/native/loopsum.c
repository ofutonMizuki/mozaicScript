/* native C baseline — speed_loopsum.moz と同一アルゴリズム/サイズ */
#include <stdio.h>
#include <stdint.h>
int main(void) {
    uint32_t sum = 0;
    for (uint32_t i = 0; i < 5000000u; i++) sum += i;
    printf("loopsum = %d\n", (int32_t)sum);
    return 0;
}
