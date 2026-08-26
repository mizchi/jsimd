# @mizchi/jsimd

Small prebuilt WebAssembly SIMD kernels and Wasm-resident data structures for data-parallel
JavaScript hot paths.

## Purpose

JavaScript does not expose a portable API for issuing explicit SIMD instructions. WebAssembly SIMD
does, but its `v128` values cannot cross the JavaScript/WebAssembly boundary. Applications therefore
need Wasm kernels that keep vector operations and intermediate data inside linear memory, exposing
only scalar results or typed-array batches to JavaScript.

This project provides compact data structures and bulk operations that cannot be expressed as
concisely or optimized as predictably in JavaScript. Their hot loops are hand-assembled in WAT for
128-bit WebAssembly SIMD, while TypeScript defines the public contracts, ownership, and `using`
lifecycle. The goal is not to replace JavaScript builtins: an entrypoint is retained only when a
measured workload justifies crossing the Wasm boundary. If equivalent behavior can be implemented
with `Map`, `Set`, or another JavaScript builtin, the jsimd implementation must beat that builtin in
its primary end-to-end workload. Smaller storage or an isolated kernel win is not sufficient.

Construction, JS/Wasm copies, output materialization, and required key conversion belong inside the
comparison unless the documented usage reuses that work across repeated operations. Point methods
needed to operate a bulk-oriented structure may remain as convenience APIs, but they are not
presented as optimizations when the corresponding builtin is faster.

Bundle size is part of that contract. Each feature has an independent Wasm binary and package
subpath, so importing one data structure does not pull in the others. The modules favor small,
specialized kernels and batched APIs that amortize boundary and copy costs.

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

All supported environments use the same entrypoints and synchronous API. The package assumes that
the runtime or bundler resolves and instantiates Wasm through ESM Integration; it does not include
an environment-specific loader. Consumers must also enable explicit resource management (`using` /
`Symbol.dispose`).

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

The package uses direct Wasm ES module imports supported by current Vite and Deno. Module loading
performs initialization; exported operations are synchronous. Lazy initialization is intentionally
deferred.

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

| export                                                                 | purpose                                      | observed speedup | slower than JS in the recorded benchmark?                 | minified JS + Wasm, gzip |
| :--------------------------------------------------------------------- | :------------------------------------------- | :--------------- | :-------------------------------------------------------- | :----------------------- |
| [`adaptive-simd-page-i32`](./src/adaptive-simd-page-i32/README.md)     | Adaptive frozen `i32` pages/columns          | 0.5–44x          | Yes — FOR scan and full decode                            | 4.63 kB + 0.83 kB        |
| [`bitmap`](./src/bitmap/README.md)                                     | Growable and fixed dense mutable bitmaps     | 9.8–19.8x        | No — small and point-heavy cases were not measured        | 2.94 kB + 0.26 kB        |
| [`bit-matrix`](./src/bit-matrix/README.md)                             | Dense Boolean matrix and frozen CSR          | 6.56x dense      | Yes — CSR traversal and small matrices                    | 3.29 kB + 0.41 kB        |
| [`byte-key-flat-hash`](./src/byte-key-flat-hash/README.md)             | Variable-byte-key map with resident arena    | 2.00x bulk       | Yes — individual gets were 12.5x slower                   | 3.37 kB + 0.73 kB        |
| [`compressed-string-table`](./src/compressed-string-table/README.md)   | Frozen front-coded byte strings              | 2.00x byte eq    | Yes — decoded strings and random materialization          | 4.18 kB + 0.34 kB        |
| [`columnar`](./src/columnar/README.md)                                 | Shared-mask i32/u32/u8 column predicates     | 2.9–40.5x        | Yes — rejected u32 sum was 2.45x slower                   | 4.76 kB + 0.93 kB        |
| [`binary-vector-index`](./src/binary-vector-index/README.md)           | Hamming search and exact PDX rerank          | 6.5–9.8x         | Yes — recall depends on candidate count                   | 4.17 kB + 0.43 kB        |
| [`blocked-vector-array`](./src/blocked-vector-array/README.md)         | Repeated exact Float32 distance scans        | 1.8–9.2x         | Yes — construction was 7.67x slower than typed-array copy | 2.56 kB + 0.43 kB        |
| [`bit-sliced-column`](./src/bit-sliced-column/README.md)               | Repeated predicates over static `u8` columns | 17.6–29.6x       | No — construction, point reads, and small scans excluded  | 3.00 kB + 0.43 kB        |
| [`blocked-bloom-filter`](./src/blocked-bloom-filter/README.md)         | Bulk negative filter before exact lookup     | 1.6–5.5x E2E     | Yes — all-hit lookup was 1.22x slower                     | 2.49 kB + 0.37 kB        |
| [`elias-fano-sequence`](./src/elias-fano-sequence/README.md)           | Global/partitioned monotone sequences        | 0.03–11.2x       | Yes — point access, decode, uniform partitioning          | 5.09 kB + 0.86 kB        |
| [`f32-vector`](./src/f32-vector/README.md)                             | Resident Float32 vector operations           | 2–7x             | No — construction and point access were excluded          | 2.04 kB + 0.17 kB        |
| [`flat-hash`](./src/flat-hash/README.md)                               | Batched `u32`/`u64` hash set/map             | 6.8–12.0x        | Yes — individual `has` and `get` calls                    | 3.35 kB + 0.95 kB        |
| [`flat-hash-fixed16`](./src/flat-hash-fixed16/README.md)               | UUID/hash-keyed map and set                  | 25.6–27.9x bulk  | Yes — numeric or point-key workloads                      | 3.02 kB + 0.62 kB        |
| [`fingerprint-group16`](./src/fingerprint-group16/README.md)           | SwissTable control groups and tables         | 1.6–4.9x bulk    | Yes — individual probes                                   | 2.33 kB + 0.27 kB        |
| [`fm-index-bytes`](./src/fm-index-bytes/README.md)                     | Frozen full-text byte search                 | 6.86x count      | Yes — construction, locate, small/frequently updated text | 4.95 kB + 1.31 kB        |
| [`i32-array`](./src/i32-array/README.md)                               | Resident fixed `i32` arrays                  | 3–7x             | No — one-shot and sub-1K cases were not measured          | 2.21 kB + 0.34 kB        |
| [`matrix2d`](./src/matrix2d/README.md)                                 | Resident Float32 matrix multiplication       | ~1–9.5x          | No — 4×4 was near parity; BLAS/GPU were not compared      | 2.51 kB + 0.23 kB        |
| [`matrix3d`](./src/matrix3d/README.md)                                 | Resident batched matrix multiplication       | 5.0–7.3x         | No — only resident generic JS loops were compared         | 2.67 kB + 0.27 kB        |
| [`packed-delta-uint32-list`](./src/packed-delta-uint32-list/README.md) | Compressed postings and monotone lists       | 0.06–1.4x        | Yes — full decode and lower-bound queries                 | 2.91 kB + 0.88 kB        |
| [`rank-select-bit-vector`](./src/rank-select-bit-vector/README.md)     | Frozen indexed `RankSelectBitVector`         | 1.5–3.0x bulk    | Yes — single-query rank                                   | 2.97 kB + 0.77 kB        |
| [`roaring-bitmap`](./src/roaring-bitmap/README.md)                     | Compressed mutable `u32` bitmap              | 2.2–175x         | No — construction and point-heavy cases were not measured | 4.74 kB + 0.53 kB        |
| [`static-mphf-u32`](./src/static-mphf-u32/README.md)                   | Frozen perfect hash for known `u32` keys     | 1.75x bulk       | Yes — individual lookup and construction                  | 4.09 kB + 0.39 kB        |
| [`wavelet-matrix-uint8`](./src/wavelet-matrix-uint8/README.md)         | Rank/range queries over frozen bytes         | 4.8x vs u32      | Yes — direct byte access                                  | 4.25 kB + 0.97 kB        |
| [`wavelet-matrix-uint32`](./src/wavelet-matrix-uint32/README.md)       | Range statistics over frozen `u32` sequences | 2.2–100x+        | Yes — direct access and exact rank                        | 4.19 kB + 0.97 kB        |

### Stateless and copy-inclusive kernels

| export                             | purpose                  | observed speedup | slower than JS in the recorded benchmark? | minified JS + Wasm, gzip |
| :--------------------------------- | :----------------------- | :--------------- | :---------------------------------------- | :----------------------- |
| [`bytes`](./src/bytes/README.md)   | General byte operations  | 4.9–18.1x        | No — small inputs use JS fallbacks        | 1.40 kB + 0.50 kB        |
| [`endian`](./src/endian/README.md) | Batched `u32` decoding   | 1.0–2.2x         | No — small inputs were at parity          | 1.11 kB + 0.18 kB        |
| [`json`](./src/json/README.md)     | JSON token-start scanner | 1.1–3.5x         | No — long strings were near parity        | 1.00 kB + 0.28 kB        |

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

## Development

Implementation priorities, benchmark gates, and deferred candidates are maintained in
[`TODO.md`](./TODO.md). A kernel is retained only when a documented workload justifies its Wasm
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
payload into `dist/`: compiled JavaScript, declarations, feature documentation, WAT sources, and the
corresponding stripped Wasm binaries. The hand-written kernels do not require Binaryen; development
only requires `wasm-tools` on `PATH`.

`just memory-profile` runs every owning data structure in an isolated Node process with explicit GC.
It fails if live Wasm allocations do not return to baseline, allocator capacity keeps growing after
warmup, or host RSS/heap/external memory does not plateau over the final rounds. Peak RSS is
reported separately because V8 may retain committed heap pages after the live objects have been
collected.
