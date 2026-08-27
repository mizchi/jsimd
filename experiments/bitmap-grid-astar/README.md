# Bitmap grid A* experiment

> [!WARNING]
> This is an experimental prototype and is not exported by `@mizchi/jsimd`. The bitmap-resident
> scalar Wasm path is promising on maze-like maps, but the SIMD heap and open-grid cases do not meet
> the public admission policy.

`BitmapGridAStar` stores immutable obstacles at one bit per cell and keeps the complete
four-neighbor A* loop, `gScore`, predecessor array, and four-ary heap in one Wasm linear memory.
Manhattan distance is the heuristic. A composite `(f, h)` integer priority prefers nodes closer to
the target when `f` ties, which prevents an open map from expanding the entire rectangle.

```ts
using grid = BitmapGridAStar.fromObstacles(width, height, blockedBytes);
const { distance, path } = grid.findPath(startX, startY, targetX, targetY);
```

`fromBitmap` accepts an existing `Uint32Array` obstacle bitmap. The canonical `findPath` uses the
faster scalar four-child selection. `findPathSimd` is retained to isolate a `v128.load`,
`i32x4.min_u`, equality mask, and bitmask implementation over the same four children.

## Recorded result

Apple M5 / Deno 2.6.4, 10 warmups and 30 measured medians. JavaScript candidates include binary and
four-ary heaps over both `Uint8Array` and bitmap obstacles. The table reports the fastest JS result.

| map              | path cells |  best JS | scalar Wasm bitmap | SIMD Wasm bitmap | scalar vs JS | SIMD vs scalar |
| :--------------- | ---------: | -------: | -----------------: | ---------------: | -----------: | -------------: |
| open 128×128     |        255 |  0.02 ms |            0.10 ms |          0.02 ms |        0.20x |          4.25x |
| barriers 128×128 |      1,912 |  0.91 ms |            0.38 ms |          0.60 ms |        2.39x |          0.63x |
| open 256×256     |        511 |  0.04 ms |            0.04 ms |          0.05 ms |        1.00x |          0.81x |
| barriers 256×256 |      7,912 |  4.12 ms |            1.69 ms |          2.74 ms |        2.44x |          0.62x |
| open 512×512     |      1,023 |  0.11 ms |            0.13 ms |          0.15 ms |        0.85x |          0.86x |
| barriers 512×512 |     32,200 | 19.60 ms |            7.95 ms |         12.55 ms |        2.47x |          0.63x |

The useful pattern is a resident, fused A* query on obstacle-heavy maps: it is about 2.4x faster
than the best JavaScript implementation here. SIMD is not the source of that gain. Four scalar child
comparisons beat horizontal SIMD reduction by 1.6x on the barrier maps, so the SIMD kernel is kept
only as negative evidence. Open maps expand roughly one path and are too small to amortize the Wasm
call and scratch initialization.

The obstacle bitmap is eight times smaller than a `Uint8Array`, but it is only a small part of total
storage. This prototype reserves duplicate-entry heap capacity and query scratch, reaching about
40.1 bytes per cell; a 512×512 grid uses 10.52 MB resident memory while its obstacle bitmap is only
32 kB. The JavaScript bitmap baseline was not faster than its byte-grid counterpart, so bitmap
packing alone is not a performance claim. An indexed heap or bounded game-specific search window is
the next memory optimization.

The isolated Vite 8.2 fixture emits 2.80 kB gzip of minified JavaScript and one 0.71 kB gzip Wasm
kernel. The prototype is outside package exports and published `dist/`.

## Reproduce

```sh
pnpm test:prototype:bitmap-grid-astar
pnpm bench:bitmap-grid-astar

# Optional isolated bundle fixture
pnpm exec tsc -p experiments/bitmap-grid-astar/tree-shake-fixture/tsconfig.json
pnpm exec vite build experiments/bitmap-grid-astar/tree-shake-fixture
```

The commands regenerate the ignored Wasm binary from
[`prototype/kernels.wat`](./prototype/kernels.wat), validate SIMD instructions, and compare complete
path reconstruction. Raw recorded medians are in
[`benchmarks/baseline.json`](./benchmarks/baseline.json).
