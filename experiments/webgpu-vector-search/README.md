# WebGPU vector-search experiment

Status: experimental and not exported from `@mizchi/jsimd`.

This experiment finds the workload size at which exact WebGPU squared-L2 top-k beats main-thread
`BlockedVectorArray` and a persistent multi-Worker Wasm SIMD index, including asynchronous result
readback. It is not an ANN index.

## Conclusion

Runtime scheduling changes the crossover by more than the kernel implementation. On Apple M5,
Chromium 152 reduced resident WebGPU's fixed boundary from Deno's 13-15 ms to roughly 0.3-0.7 ms.
The Chromium path beat main-thread Wasm SIMD at 65,536 rows x 128 dimensions for one query and beat
the persistent four-Worker SIMD index at 262,144 rows for one query. With four or more queries per
batch, WebGPU won earlier and reached roughly 2.2-2.5x over the Worker index on the largest input.

This is still not a package export. Uploading and transposing a 128 MiB input for each query costs
roughly 210-321 ms across the recorded runtimes, only one hardware adapter has been recorded, and
small workloads remain much faster on Wasm SIMD. The viable contract is a long-lived resident GPU
index with batched queries and only final top-k pairs read back.

The GPU index transposes row-major input once into a dimension-major resident buffer. One invocation
computes each row distance, every 256-row workgroup emits local top-k candidates, and further GPU
passes recursively reduce those candidates. JavaScript reads only the final `queryCount * k`
`{ distance: f32, id: u32 }` pairs instead of every distance.

```text
row-major Float32 input
  -> one-time dimension-major GPU upload
  -> squared-L2 workgroups
  -> recursive exact top-k reduction
  -> k * 8-byte readback per query
```

## API sketch

```ts
await using search = await WebGpuVectorSearch.create({
  maxK: 10,
  maxBatchSize: 64,
  inFlightSlots: 3,
});
using index = search.upload(vectors, rows, dimensions);

const one = await index.topK(query, 10);
const batch = await index.topKBatch(queries, 64, 10);

// Experimental alternatives measured by this experiment:
const combined = await index.topKBatchSingleSubmission(queries, 64, 10);
const overlapped = await Promise.all([
  index.topKBatch(queriesA, 64, 10),
  index.topKBatch(queriesB, 64, 10),
]);
```

The owning search object uses `await using`; each uploaded index uses `using`. Concurrent queries
use independent query, parameter, scratch, and readback slots. Submitting more promises than
`inFlightSlots` rejects instead of silently allocating more GPU memory.

## Chromium 152 matrix

Apple M5 / Metal 3, 128 dimensions, exact `k=10`, four persistent Wasm Workers, five warmups, and 15
samples. Every recorded GPU result matched `BlockedVectorArray` IDs and distances. Raw samples,
runtime, adapter, CPU, p95, construction-inclusive upload, ring, and submission results are in
[`benchmarks/chromium.json`](./benchmarks/chromium.json).

Each cell is resident WebGPU speedup over sequential main-thread Wasm SIMD:

| Rows / query batch |     1 |     4 |    16 |    64 |   128 |
| -----------------: | ----: | ----: | ----: | ----: | ----: |
|              1,024 | 0.03x | 0.05x | 0.16x | 0.67x | 1.39x |
|              4,096 | 0.10x | 0.38x | 1.55x | 1.54x | 2.32x |
|             16,384 | 0.28x | 1.24x | 2.50x | 2.38x | 2.47x |
|             65,536 | 1.01x | 2.31x | 2.58x | 2.75x | 2.83x |
|            262,144 | 1.17x | 2.77x | 2.93x | 2.87x | 2.83x |

Each cell is resident WebGPU speedup over the persistent four-Worker SIMD index:

| Rows / query batch |     1 |     4 |    16 |    64 |   128 |
| -----------------: | ----: | ----: | ----: | ----: | ----: |
|              1,024 | 0.09x | 0.30x | 0.95x | 2.71x | 6.69x |
|              4,096 | 0.30x | 0.85x | 2.44x | 3.00x | 5.48x |
|             16,384 | 0.37x | 1.02x | 2.10x | 2.51x | 3.01x |
|             65,536 | 0.58x | 1.70x | 2.36x | 2.39x | 2.50x |
|            262,144 | 1.01x | 2.22x | 2.36x | 2.30x | 2.43x |

The Worker comparison uses the shared-memory PDX64 kernel from `experiments/parallel-hybrid-query`,
includes Worker notification and result merging, and keeps its Worker pool persistent. It
intentionally runs batch members sequentially because that index exposes a single shared query slot.

### In-flight ring

Two or three slots overlap scheduling and mapping for independent submissions. At 16,384 rows, three
single-query submissions completed 2.01x faster than repeating the one-slot latency three times.
Once a large batch saturates GPU compute, the benefit disappeared: three 64-query submissions were
only 1.04x at 16,384 rows and 1.01x at 262,144 rows. Each slot duplicates query, candidate, and
readback storage, so one slot remains preferable for saturated workloads.

### Fewer submissions

`topKBatchSingleSubmission()` encodes the distance pass, recursive reductions, and readback copy in
one command buffer. Across the matrix it was usually 0.94-1.04x versus separate submissions; the
largest isolated improvement was 1.26x at 65,536 rows with one query. Queue submission count is not
the general crossover bottleneck, so this remains an experimental comparison method rather than the
default path.

## Deno baseline

Apple M5, Deno 2.6.4 `--unstable-webgpu`, 128 dimensions, exact `k=10`, 5 warmups and 15 samples.
The production resident path submits compute and the final copy before one `mapAsync`. The profiled
readback column inserts an extra synchronization point to isolate the copy/map fixed cost, so it
must not be added to the production end-to-end time. The versioned
[`benchmarks/baseline.json`](./benchmarks/baseline.json) retains every raw sample.

|    Rows |   Input | Wasm SIMD | WebGPU resident | Profiled readback | Upload each query |
| ------: | ------: | --------: | --------------: | ----------------: | ----------------: |
|   1,024 | 0.5 MiB |   0.05 ms |        14.92 ms |          13.48 ms |          15.30 ms |
|   4,096 |   2 MiB |   0.03 ms |        14.91 ms |          12.97 ms |          17.47 ms |
|  16,384 |   8 MiB |   0.17 ms |        15.79 ms |          13.46 ms |          30.09 ms |
|  65,536 |  32 MiB |   0.58 ms |        13.83 ms |          13.58 ms |          67.02 ms |
| 262,144 | 128 MiB |   4.56 ms |        17.69 ms |          13.23 ms |         320.55 ms |

No single-query crossover was observed. Even returning only 80 bytes, Deno/wgpu mapping and
scheduling imposed roughly 13-15 ms on this machine. Re-uploading and transposing the vectors for
every query was always substantially slower.

Batching queries amortizes that fixed boundary. Each cell below is WebGPU speedup over sequential
Wasm SIMD calls; values above 1 are wins.

| Rows / query batch |     1 |         4 |        16 |        64 |       128 |
| -----------------: | ----: | --------: | --------: | --------: | --------: |
|              1,024 | 0.00x |     0.00x |     0.01x |     0.03x |     0.06x |
|              4,096 | 0.00x |     0.01x |     0.03x |     0.12x |     0.25x |
|             16,384 | 0.02x |     0.03x |     0.11x |     0.45x |     0.67x |
|             65,536 | 0.04x |     0.18x |     0.61x | **2.08x** | **2.52x** |
|            262,144 | 0.25x | **1.06x** | **1.91x** | **2.69x** | **3.08x** |

The first crossover was 262,144 rows x 128 dimensions x four queries, but its 1.06x margin is too
small to use as a robust dispatch threshold. The clearest measured win was 262,144 rows x 128
dimensions x 128 queries: WebGPU took 224.45 ms versus 691.64 ms for Wasm SIMD, a 3.08x speedup,
while reading back only 10 KiB.

This threshold is runtime- and adapter-specific, not a portable constant. Browsers may schedule
mapping differently. WebGPU specifies `mapAsync()` as the synchronization point that makes GPU
buffer contents accessible to JavaScript, and Deno currently exposes WebGPU behind an unstable flag.
See the [WebGPU buffer mapping specification](https://www.w3.org/TR/webgpu/#buffer-mapping) and
[Deno unstable WebGPU documentation](https://docs.deno.com/runtime/reference/cli/unstable_flags/#--unstable-webgpu).

## Run

```sh
just test-webgpu-vector-search
just bench-webgpu-vector-search
just bench-record-webgpu-vector-search
just bench-webgpu-vector-search-browser
just bench-record-webgpu-vector-search-browser
```

Environment overrides:

```sh
JSIMD_WEBGPU_ROWS=16384,65536 \
JSIMD_WEBGPU_BATCHES=1,16,64 \
JSIMD_WEBGPU_DIMENSIONS=128 \
JSIMD_WEBGPU_IN_FLIGHT=1,2,3 \
JSIMD_WEBGPU_WORKERS=4 \
just bench-webgpu-vector-search-browser
```

The experiment deliberately keeps GPU code out of the package exports. Before reconsidering a public
API, reproduce the win on additional adapters and browser versions and define how callers keep a
large index resident without making upload latency part of the interactive query path.
