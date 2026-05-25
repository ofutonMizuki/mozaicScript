/* native C baseline — speed_primes.moz と同一（エラトステネスの篩） */
#include <stdio.h>
#include <stdint.h>
#define N 500000u
static int32_t sieve[N];
int main(void) {
    for (uint32_t i = 0; i < N; i++) sieve[i] = 0;
    sieve[0] = 1; sieve[1] = 1;
    for (uint32_t p = 2; p * p < N; p++)
        if (!sieve[p])
            for (uint32_t m = p * p; m < N; m += p) sieve[m] = 1;
    int32_t c = 0;
    for (uint32_t i = 2; i < N; i++) if (!sieve[i]) c++;
    printf("primes < 500000 = %d\n", c);
    return 0;
}
