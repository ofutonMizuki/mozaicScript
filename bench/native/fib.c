/* native C baseline — speed_fib.moz と同一 */
#include <stdio.h>
#include <stdint.h>
static int32_t fib(int32_t n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
int main(void) {
    printf("fib(32) = %d\n", fib(32));
    return 0;
}
