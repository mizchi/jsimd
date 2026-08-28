# @mizchi/jsimd

Small prebuilt WebAssembly SIMD kernels and Wasm-resident data structures for data-parallel
JavaScript hot paths.

## Goal

jsimd provides small, tree-shakeable data structures and bulk operations powered by hand-written
WebAssembly SIMD kernels. It targets JavaScript hot paths where explicit SIMD can outperform the
equivalent built-in implementation end to end.

Each feature ships as an independent package subpath with documented performance, boundary-cost, and
bundle-size trade-offs.

## Install

```sh
pnpm add @mizchi/jsimd
```

## Runtime requirements

- Node.js 24.5 or later
- Deno 2.6 or later
- Vite 8 or later
- WebAssembly SIMD
- WebAssembly ESM Integration for direct `.wasm` imports

The optional `shared-buffer` entrypoint additionally requires WebAssembly threads and shared memory.
The `ultra-log-log-parallel` entrypoint requires `SharedArrayBuffer` and Workers but performs no
atomic Wasm access. Browsers normally expose shared buffers through cross-origin isolation. Node
uses `node:worker_threads`; Deno and browsers use Web Workers. Their factories are asynchronous
because each Worker must initialize its module.

All supported environments use the same entrypoints. Existing single-threaded entrypoints expose
synchronous operations after ESM Integration instantiates their Wasm modules. `shared-buffer` is the
exception: its asynchronous factories compile the same kernel in each Worker against caller-owned
shared memory. Consumers must also enable explicit resource management (`using` / `Symbol.dispose`).

## Usage

```ts
import { indexOf } from "@mizchi/jsimd/bytes";
import { WaveletMatrixUint32 } from "@mizchi/jsimd/wavelet-matrix-uint32";

const bytes = new TextEncoder().encode("simd:simd");
indexOf(bytes, 0x3a); // 4
indexOf(bytes, new TextEncoder().encode("simd")); // 0

// Wasm-resident data structures own memory, so release them with `using`.
using values = WaveletMatrixUint32.from([3, 1, 4, 1, 5, 9]);
values.rank(1, values.length); // 2
values.rangeFreq(0, values.length, 1, 5); // 4
values.quantile(0, values.length, 3); // 4
```

The single-threaded entrypoints use direct Wasm ES module imports supported by current Vite and
Deno. Module loading performs initialization, after which their exported operations are synchronous.

## Implementation guide

Each link below opens the feature README with its complete API, algorithm and literature sources,
benchmark setup, and exact results. This table is only a rounded selection guide.

Owning structures keep data in Wasm linear memory and should be declared with `using`. They are a
good fit when several bulk operations reuse resident data. Native arrays and collections usually
remain the better choice for small inputs, one-shot work, point access, or workloads that repeatedly
materialize complete results back into JavaScript.

Disposal returns allocator blocks to an internal reuse pool; it does not shrink
`WebAssembly.Memory`. A stable `reservedBytes` or `memoryBytes` value after a workload is therefore
expected. Stateful entrypoints expose `allocatorStats()` so tests can require `liveAllocations` and
`liveBytes` to return to their baseline after each `using` scope.

### Data structures

The canonical bitmap subpaths are `bitmap`, `rank-select-bit-vector`, and `roaring-bitmap`.
`bit-vector` is intentionally reserved for a future immutable packed-bit sequence without a
rank/select index; it is not currently exported. Pre-announcement compatibility aliases were removed
so each structure has one public name.

| export                                                                 | purpose                                      | observed speedup | trade-off                                             | minified JS + Wasm, gzip |
| :--------------------------------------------------------------------- | :------------------------------------------- | :--------------- | :---------------------------------------------------- | :----------------------- |
| [`adaptive-simd-page-i32`](./src/adaptive-simd-page-i32/README.md)     | Adaptive frozen `i32` pages/columns          | 0.5–41x          | Compressed decode/construction can be slower          | 5.84 kB + 1.63 kB        |
| [`bitmap`](./src/bitmap/README.md)                                     | Growable and fixed dense mutable bitmaps     | 9.8–19.8x        | Small and point-heavy cases were not measured         | 2.94 kB + 0.26 kB        |
| [`bit-histogram32`](./src/bit-histogram32/README.md)                   | Streaming positional popcount for u32 flags  | 1.9–14.4x        | One word was 9.03x slower than JavaScript             | 2.17 kB + 0.27 kB        |
| [`bit-matrix`](./src/bit-matrix/README.md)                             | Dense Boolean matrix and frozen CSR          | 6.56x dense      | CSR traversal and small matrices can be slower        | 3.29 kB + 0.41 kB        |
| [`byte-key-flat-hash`](./src/byte-key-flat-hash/README.md)             | Variable-byte-key map with resident arena    | 2.00x bulk       | Individual gets were 12.5x slower                     | 3.37 kB + 0.73 kB        |
| [`compressed-string-table`](./src/compressed-string-table/README.md)   | Frozen front-coded byte strings              | 2.00x byte eq    | Decode and random materialization can be slower       | 4.18 kB + 0.34 kB        |
| [`columnar`](./src/columnar/README.md)                                 | Shared-mask i32/u32/u8 column predicates     | 2.9–40.5x        | Dense extraction and one-shot build can lose to JS    | 7.17 kB + 1.16 kB        |
| [`binary-vector-index`](./src/binary-vector-index/README.md)           | Hamming search and exact PDX rerank          | 6.5–9.8x         | Recall depends on candidate count                     | 4.17 kB + 0.43 kB        |
| [`blocked-vector-array`](./src/blocked-vector-array/README.md)         | Repeated exact Float32 vector scoring        | 1.2–9.2x         | Construction was 7.24x slower than typed-array copy   | 2.87 kB + 0.92 kB        |
| [`bit-sliced-column`](./src/bit-sliced-column/README.md)               | Repeated predicates over static `u8` columns | 17.6–29.6x       | Construction, point reads, and small scans excluded   | 3.00 kB + 0.43 kB        |
| [`blocked-bloom-filter`](./src/blocked-bloom-filter/README.md)         | Bulk negative filter before exact lookup     | 1.6–5.5x E2E     | All-hit lookup was 1.22x slower                       | 2.49 kB + 0.37 kB        |
| [`elias-fano-sequence`](./src/elias-fano-sequence/README.md)           | Global/partitioned monotone sequences        | 0.03–11.2x       | Point access, decode, and uniform partitions are slow | 5.09 kB + 0.86 kB        |
| [`f32-vector`](./src/f32-vector/README.md)                             | Resident Float32 vector operations           | 4–24x bulk       | Tiny and one-shot work can be slower                  | 2.12 kB + 0.31 kB        |
| [`flat-hash`](./src/flat-hash/README.md)                               | Batched `u32`/`u64` hash set/map             | 6.8–12.0x        | Individual `has` and `get` calls are slower           | 3.35 kB + 0.95 kB        |
| [`flat-hash-fixed16`](./src/flat-hash-fixed16/README.md)               | UUID/hash-keyed map and set                  | 25.6–27.9x bulk  | Numeric and point-key workloads can be slower         | 3.02 kB + 0.62 kB        |
| [`fingerprint-group16`](./src/fingerprint-group16/README.md)           | SwissTable control groups and tables         | 1.6–4.9x bulk    | Individual probes are slower                          | 2.33 kB + 0.27 kB        |
| [`fm-index-bytes`](./src/fm-index-bytes/README.md)                     | Frozen full-text byte search                 | 6.86x count      | Construction, locate, and mutable text can be slower  | 4.95 kB + 1.31 kB        |
| [`i32-array`](./src/i32-array/README.md)                               | Resident fixed `i32` arrays                  | 3–7x             | One-shot and sub-1K cases were not measured           | 2.21 kB + 0.34 kB        |
| [`matrix2d`](./src/matrix2d/README.md)                                 | Resident Float32 matrix multiplication       | ~1–9.5x          | 4×4 was near parity; BLAS/GPU were not compared       | 2.51 kB + 0.23 kB        |
| [`matrix3d`](./src/matrix3d/README.md)                                 | Resident batched matrix multiplication       | 5.0–7.3x         | Compared only with resident generic JS loops          | 2.67 kB + 0.27 kB        |
| [`packed-delta-uint32-list`](./src/packed-delta-uint32-list/README.md) | Compressed postings and monotone lists       | 0.06–1.4x        | Full decode and lower-bound queries are slower        | 2.91 kB + 0.88 kB        |
| [`rank-select-bit-vector`](./src/rank-select-bit-vector/README.md)     | Frozen indexed `RankSelectBitVector`         | 1.5–3.0x bulk    | Single-query rank is slower                           | 2.97 kB + 0.77 kB        |
| [`roaring-bitmap`](./src/roaring-bitmap/README.md)                     | Compressed mutable `u32` bitmap              | 2.2–175x         | Construction and point-heavy cases were not measured  | 4.74 kB + 0.53 kB        |
| [`shared-buffer`](./src/shared-buffer/README.md)                       | Shared memory, queues, snapshots, reduction  | 1.30–7.96x bulk  | Pool lease was 1.10x slower; scheduling excluded      | 26.65 kB + 0.33 kB       |
| [`static-mphf-u32`](./src/static-mphf-u32/README.md)                   | Frozen perfect hash for known `u32` keys     | 1.75x bulk       | Individual lookup and construction are slower         | 4.09 kB + 0.39 kB        |
| [`ultra-log-log`](./src/ultra-log-log/README.md)                       | Mergeable approximate `u32` distinct count   | 2.16–22.53x      | Small batches select scalar JavaScript                | 4.08 kB + 0.57 kB        |
| [`ultra-log-log-parallel`](./src/ultra-log-log-parallel/README.md)     | Persistent-Worker bulk distinct count        | 2.39–5.38x E2E   | Forced 4K Worker path was 3.45x slower                | 9.43 kB + 0.57 kB        |
| [`wavelet-matrix-uint8`](./src/wavelet-matrix-uint8/README.md)         | Rank/range queries over frozen bytes         | 4.8x vs u32      | Direct byte access is slower                          | 4.25 kB + 0.97 kB        |
| [`wavelet-matrix-uint16`](./src/wavelet-matrix-uint16/README.md)       | Range queries over frozen `u16` sequences    | 2.3–329x         | Direct access and exact rank are slower               | 4.26 kB + 0.97 kB        |
| [`wavelet-matrix-uint32`](./src/wavelet-matrix-uint32/README.md)       | Range statistics over frozen `u32` sequences | 2.2–100x+        | Direct access and exact rank are slower               | 4.19 kB + 0.97 kB        |

### Stateless and copy-inclusive kernels

| export                             | purpose                  | observed speedup | trade-off                     | minified JS + Wasm, gzip |
| :--------------------------------- | :----------------------- | :--------------- | :---------------------------- | :----------------------- |
| [`bytes`](./src/bytes/README.md)   | General byte operations  | 4.9–18.1x        | Small inputs use JS fallbacks | 1.40 kB + 0.50 kB        |
| [`endian`](./src/endian/README.md) | Batched `u32` decoding   | 1.0–2.2x         | Small inputs were at parity   | 1.11 kB + 0.18 kB        |
| [`json`](./src/json/README.md)     | JSON token-start scanner | 1.1–3.5x         | Long strings were near parity | 1.00 kB + 0.28 kB        |

### How to read the numbers

Performance results were recorded on Apple M5 with Node 24 or Deno 2.6 as documented by each linked
feature README. They are workload samples, not cross-feature scores. Resident benchmarks usually
exclude construction and final materialization; copy-inclusive kernels explicitly include boundary
copies. Rerun the linked benchmark on the target engine and data distribution before choosing a
representation.

Admission is based on the documented primary workload, not on every convenience method. A row that
reports a slower JS case is retained only when a separate, representative bulk workload wins; that
slower operation is outside the performance contract.

Build sizes come from isolated Vite 8.2 production fixtures. Each cell reports only the gzip sizes
of the minified JavaScript output and its independently emitted, stripped Wasm asset. Importing a
subpath does not pull in another feature's Wasm. A real application may share wrapper code or add
other runtime code, so these figures are marginal fixtures rather than a prediction of total bundle
size. Raw sizes remain available in each feature README.

The package is distributed as one npm package with subpath exports. npm releases contain compiled
JavaScript and adjacent declarations; consumers do not need TypeScript runtime transformation for
files under `node_modules`. Each `.wasm` import is typed by an adjacent `kernels.d.wasm.ts`,
following Vite's `allowArbitraryExtensions` convention, without a generated environment-specific
loader.

## Examples

- [`multithread-vector-search`](../../examples/multithread-vector-search/README.md) shards an exact
  Float32 index across Web Workers, uses shared SPSC task notification and result slots, and merges
  only `workerCount × k` candidates on the coordinator.

## Storage package

[`@mizchi/jsimd-columnar`](../columnar/README.md) builds typed schemas, ZoneMap/projection pushdown,
resident SIMD page caching, and interchangeable Memory, IndexedDB, and Node filesystem backends. It
is versioned separately as an experimental `0.x` package: warm queries win the recorded selective
workload, while cold storage restore remains slower than already-resident page-aware JavaScript.

## Development

Implementation priorities, benchmark gates, and deferred candidates are maintained in
[`TODO.md`](../../TODO.md). A kernel is retained only when a documented workload justifies its Wasm
boundary and bundle cost against the best relevant JavaScript builtin or scalar reference.

```sh
pnpm install
just build
just test
just bench
just memory-profile
```

`just build` compiles each `src/<name>/kernels.wat` into its adjacent `kernels.wasm`. Generated Wasm
files have custom sections removed with `wasm-tools strip -a`, are checked with
`wasm-tools validate --features simd`, and are ignored by Git. `just build-package` emits the npm
payload into `packages/jsimd/dist/`: compiled JavaScript, declarations, feature documentation, WAT
sources, and the corresponding stripped Wasm binaries. The hand-written kernels do not require
Binaryen; development only requires `wasm-tools` on `PATH`.

`just memory-profile` runs every owning data structure in an isolated Node process with explicit GC.
It fails if live Wasm allocations do not return to baseline, allocator capacity keeps growing after
warmup, or post-GC heap/external/ArrayBuffer memory does not plateau over the final rounds. Peak RSS
is reported as an informational high-water mark because V8/Wasm tier-up and native allocators can
retain code or arena pages after owned storage has been released.
