/* native C baseline — speed_matrix.moz と同一（LCG 充填→整数行列積→トレース） */
#include <stdio.h>
#include <stdint.h>
#define N 90u
static uint32_t lcg(uint32_t s) { return s * 1664525u + 1013904223u; }
static int32_t A[N * N], B[N * N], C[N * N];
int main(void) {
    uint32_t s = 7;
    for (uint32_t i = 0; i < N * N; i++) {
        s = lcg(s); A[i] = (int32_t)(s % 10u);
        s = lcg(s); B[i] = (int32_t)(s % 10u);
        C[i] = 0;
    }
    for (uint32_t row = 0; row < N; row++)
        for (uint32_t col = 0; col < N; col++) {
            int32_t acc = 0;
            for (uint32_t k = 0; k < N; k++) acc += A[row * N + k] * B[k * N + col];
            C[row * N + col] = acc;
        }
    int32_t trace = 0;
    for (uint32_t i = 0; i < N; i++) trace += C[i * N + i];
    printf("matrix trace = %d\n", trace);
    return 0;
}
