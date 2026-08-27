# SIMD priority queue and Dijkstra experiment

> [!WARNING]
> This is a rejected public `SimdPriorityQueue` prototype. It is retained as a reproducible
> experiment and is not exported by `@mizchi/jsimd`.

The prototype implements a growable four-ary min heap with `f32` priorities and `u32` IDs. During
`pop`, a full group of four child priorities is loaded with `v128`, reduced with `f32x4.min`, and
matched with `f32x4.eq` plus `i32x4.bitmask`. Equal priorities use the smallest unsigned ID. Pushes
remain scalar because a sift-up follows one dependent parent chain.

The experiment exposes two layers:

- `SimdPriorityQueueU32`: a normal TypeScript API crossing the JS/Wasm boundary for each `pop`.
- `DijkstraCsrGraph`: an immutable CSR graph whose complete Dijkstra loop and four-ary heap remain
  in Wasm. `shortestPathScalar` changes only child selection to scalar code, which isolates the SIMD
  contribution.

```ts
using graph = DijkstraCsrGraph.from(offsets, targets, weights);
const { distance, path } = graph.shortestPath(start, target);
```

The graph accepts finite non-negative `Float32` weights. It uses duplicate heap entries instead of
decrease-key, reserves worst-case heap space proportional to the edge count, and reuses distance,
predecessor, and heap storage between sequential queries.

## Recorded result

Apple M5 / Deno 2.6.4, 3 warmups and 20 measured medians. The weighted four-neighbor grids and all
implementations reconstruct the path, not only its distance.

| workload               | best JS | scalar Wasm 4-ary | SIMD Wasm 4-ary | SIMD vs scalar | SIMD vs JS |
| :--------------------- | ------: | ----------------: | --------------: | -------------: | ---------: |
| 64×64 grid             | 0.17 ms |           0.14 ms |         0.12 ms |          1.18x |      1.39x |
| 128×128 grid           | 1.32 ms |           1.36 ms |         0.91 ms |          1.49x |      1.45x |
| 256×256 grid           | 6.35 ms |           6.41 ms |         5.48 ms |          1.17x |      1.16x |
| 65,536 push/pop pairs  | 6.70 ms |                 — |         8.76 ms |              — |      0.76x |
| batch push, point pops | 6.70 ms |                 — |         8.94 ms |              — |      0.75x |

SIMD child selection itself improves the resident Wasm Dijkstra kernel by 1.17–1.49x in this
workload. End-to-end pathfinding is 1.16–1.45x faster than the better JavaScript binary/four-ary
heap result. However, a reusable priority queue is 24–25% slower than JavaScript because point
operations repeatedly cross the JS/Wasm boundary. Batch insertion does not help when every result
must still be popped separately.

The result supports a fused, Wasm-resident graph operator, but not a public general-purpose SIMD
priority queue. More graph distributions and larger gains are required before promoting
`DijkstraCsrGraph` into `src/`.

The isolated Vite 8.2 fixture emits 3.36 kB gzip of minified JavaScript and one 0.75 kB gzip Wasm
kernel. None of this prototype is included when applications import a published jsimd subpath.

The SIMD operations follow the
[WebAssembly SIMD specification](https://github.com/WebAssembly/spec/blob/main/proposals/simd/SIMD.md).
The committed raw measurements are in [`benchmarks/baseline.json`](./benchmarks/baseline.json).

## Reproduce

```sh
pnpm test:prototype:simd-priority-queue
pnpm bench:simd-priority-queue

# Optional archived bundle-size fixture
pnpm exec tsc -p experiments/simd-priority-queue/tree-shake-fixture/tsconfig.json
pnpm exec vite build experiments/simd-priority-queue/tree-shake-fixture
```

Both commands generate the ignored `prototype/kernels.wasm` from the hand-written WAT and validate
it with `wasm-tools validate --features simd` before execution.
