/* native C baseline — speed_mandelbrot.moz と同一（f32 = float） */
#include <stdio.h>
int main(void) {
    const int W = 220, H = 150, MAXIT = 120;
    int inside = 0;
    for (int py = 0; py < H; py++) {
        float y0 = (float)py / (float)H * 2.0f - 1.0f;
        for (int px = 0; px < W; px++) {
            float x0 = (float)px / (float)W * 3.0f - 2.0f;
            float zx = 0.0f, zy = 0.0f;
            int it = 0, escaped = 0;
            while (it < MAXIT) {
                float xx = zx * zx, yy = zy * zy;
                if (xx + yy > 4.0f) { escaped = 1; break; }
                float nzy = 2.0f * zx * zy + y0;
                zx = xx - yy + x0;
                zy = nzy;
                it++;
            }
            if (!escaped) inside++;
        }
    }
    printf("mandelbrot inside pts = %d\n", inside);
    return 0;
}
