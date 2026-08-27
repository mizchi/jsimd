# WebGPU vector-search experiment

Status: experimental and not exported from `@mizchi/jsimd`.

This experiment finds the workload size at which exact WebGPU squared-L2 top-k beats the existing
single-threaded Wasm SIMD `BlockedVectorArray`, including the asynchronous result readback. It is
not an ANN index.

## Conclusion

Do not use WebGPU for a single exact top-k query or when vectors must be uploaded for each query. On
the recorded Apple M5 / Deno 2.6.4 setup, no single-query crossover appeared through 262,144 rows x
128 dimensions: resident WebGPU took 15.87 ms while Wasm SIMD took 2.23 ms. Uploading and
transposing the same 128 MiB input for every query increased WebGPU latency to 217.59 ms.

The viable workload is a resident index with many queries submitted as one batch and only final
top-k pairs returned:

- 65,536 rows x 128 dimensions x 128 queries: 1.09x faster than sequential Wasm SIMD.
- 262,144 rows x 128 dimensions x 64 queries: 1.30x faster.
- 262,144 rows x 128 dimensions x 128 queries: 1.29x faster.

The observed crossover was approximately one billion `rows * dimensions * queries` distance terms
per readback. This is an empirical threshold for this adapter/runtime, not a portable constant. The
implementation therefore remains an experiment and is not a package export.

The next admission checks are:

1. reproduce the matrix in Chromium rather than assuming Deno/wgpu scheduling is representative;
2. overlap batches with a ring of staging/readback buffers;
3. compare against the persistent multi-Worker SIMD index, not only single-threaded
   `BlockedVectorArray`;
4. admit a public API only if the complete resident workload still wins after scheduling and
   readback.

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
});
using index = search.upload(vectors, rows, dimensions);

const one = await index.topK(query, 10);
const batch = await index.topKBatch(queries, 64, 10);
```

The owning search object uses `await using`; each uploaded index uses `using`. Queries on one index
are intentionally serialized because its query, scratch, and mapping buffers are reused. Use
separate indexes or a future staging-ring implementation for concurrent submissions.

## Recorded baseline

Apple M5, Deno 2.6.4 `--unstable-webgpu`, 128 dimensions, exact `k=10`, 5 warmups and 15 samples.
The production resident path submits compute and the final copy before one `mapAsync`. The profiled
readback column inserts an extra synchronization point to isolate the copy/map fixed cost, so it
must not be added to the production end-to-end time.

|    Rows |   Input | Wasm SIMD | WebGPU resident | Profiled readback | Upload each query |
| ------: | ------: | --------: | --------------: | ----------------: | ----------------: |
|   1,024 | 0.5 MiB |   0.02 ms |        14.33 ms |          13.13 ms |          15.26 ms |
|   4,096 |   2 MiB |   0.03 ms |        14.81 ms |          13.38 ms |          17.43 ms |
|  16,384 |   8 MiB |   0.12 ms |        15.25 ms |          12.59 ms |          26.33 ms |
|  65,536 |  32 MiB |   0.82 ms |        14.71 ms |          13.07 ms |          62.59 ms |
| 262,144 | 128 MiB |   2.23 ms |        15.87 ms |          13.42 ms |         217.59 ms |

No single-query crossover was observed. Even returning only 80 bytes, Deno/wgpu mapping and
scheduling imposed roughly 13-15 ms on this machine. Re-uploading and transposing the vectors for
every query was always substantially slower.

Batching queries amortizes that fixed boundary. Each cell below is WebGPU speedup over sequential
Wasm SIMD calls; values above 1 are wins.

| Rows / query batch |     1 |     4 |    16 |        64 |       128 |
| -----------------: | ----: | ----: | ----: | --------: | --------: |
|              1,024 | 0.00x | 0.00x | 0.01x |     0.04x |     0.06x |
|              4,096 | 0.00x | 0.01x | 0.03x |     0.12x |     0.22x |
|             16,384 | 0.01x | 0.03x | 0.10x |     0.42x |     0.86x |
|             65,536 | 0.03x | 0.13x | 0.49x |     0.88x | **1.09x** |
|            262,144 | 0.14x | 0.55x | 0.98x | **1.30x** | **1.29x** |

The useful baseline is therefore approximately one billion `row * dimension * query` distance terms
per readback on this setup. The clearest measured win was 262,144 rows x 128 dimensions x 64
queries: WebGPU took 126.95 ms versus 164.69 ms for Wasm SIMD, a 1.30x speedup, while reading back
only 5 KiB.

This threshold is runtime- and adapter-specific, not a portable constant. Browsers may schedule
mapping differently. WebGPU specifies `mapAsync()` as the synchronization point that makes GPU
buffer contents accessible to JavaScript, and Deno currently exposes WebGPU behind an unstable flag.
See the [WebGPU buffer mapping specification](https://www.w3.org/TR/webgpu/#buffer-mapping) and
[Deno unstable WebGPU documentation](https://docs.deno.com/runtime/reference/cli/unstable_flags/#--unstable-webgpu).

## Run

```sh
just test-webgpu-vector-search
just bench-webgpu-vector-search
```

Environment overrides:

```sh
JSIMD_WEBGPU_ROWS=16384,65536 \
JSIMD_WEBGPU_BATCHES=1,16,64 \
JSIMD_WEBGPU_DIMENSIONS=128 \
just bench-webgpu-vector-search
```

The experiment deliberately keeps GPU code out of the package exports. A browser benchmark, multiple
in-flight staging buffers, command-encoder reuse, and a comparison against the persistent
multi-Worker index are required before considering a public API.
