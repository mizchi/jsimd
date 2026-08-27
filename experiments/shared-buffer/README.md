# SharedBuffer experiments

The admitted benchmark compares owner-only bulk fill over the same `SharedArrayBuffer`. It measures
only the operation after asynchronous module compilation and shared-memory creation; Worker startup,
attachment, and point atomics are separate concerns.

```sh
pnpm bench:shared-buffer
pnpm bench:record:shared-buffer
pnpm bench:compare:shared-buffer
```

Point atomic operations intentionally use JavaScript `Atomics` directly. An exploratory Wasm
function-call wrapper was about 3.34x slower for repeated scalar additions on Apple M5 / Node 24.12,
so that wrapper was removed from the public API and binary.

The block-pool microbenchmark compares one Worker-local 256-byte lease, including its JavaScript
lease and view objects, with a native `Uint8Array` allocation. It is a cost/trade-off measurement,
not an equivalence claim: the native array is GC-owned and cannot serve as an offset in shared Wasm
memory.

Recorded on Apple M5 / Node 24.12, the pool lease averaged 0.000184 ms versus 0.000167 ms for
`new Uint8Array(256)`, making native allocation 1.10x faster.

The sharded bitmap benchmark reduces four resident 1,048,576-bit shards into a reused shared result.
Recorded on the same runtime, SIMD OR averaged 0.0122 ms versus 0.0929 ms for a scalar shared typed
array loop (7.62x faster); SIMD AND averaged 0.0120 ms versus 0.0956 ms (7.96x faster). Worker
startup and barrier latency are deliberately excluded so this measures the admitted resident bulk
kernel rather than a full scheduling workload.

The striped histogram benchmark reduces four resident 32,768-bucket u32 stripes. SIMD averaged
0.0173 ms versus 0.1203 ms for the scalar shared typed-array loop (6.96x faster). Counts wrap at
u32, and the benchmark excludes Worker startup, point updates, and barrier latency.
