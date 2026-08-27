# BitHistogram32 experiment

Compares a complete 32-counter SIMD positional-popcount with copy-inclusive and reused resident
ownership against fixed-width and set-bit-only JavaScript loops. Dense random words and sparse
three-bit flags are measured separately so a dense-only kernel win does not hide the sparse flag
trade-off.

The committed Apple M5 / Node 24 baseline counts 262,144 words. Copy-inclusive SIMD took 0.301 ms
for dense input versus 4.350 ms for the best JavaScript loop (14.4x), and 0.293 ms for sparse
three-bit flags versus 1.363 ms for a set-bit-only loop (4.66x). It remained 1.91x faster at 64
dense words, while the one-word case was 9.03x slower than JavaScript.

```sh
pnpm bench:bit-histogram32
pnpm bench:record:bit-histogram32
```
