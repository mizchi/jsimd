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
measured workload justifies crossing the Wasm boundary.

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
import { findByte, indexOfSubarray } from "@mizchi/jsimd";
import { WaveletMatrixUint32 } from "@mizchi/jsimd/wavelet-matrix-uint32";

const bytes = new TextEncoder().encode("simd:simd");
findByte(bytes, 0x3a); // 4
indexOfSubarray(bytes, new TextEncoder().encode("simd")); // 0

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

| export                                                                 | purpose                                      | observed speedup | slower than JS in the recorded benchmark?                 | minified JS + Wasm, raw (gzip)   |
| :--------------------------------------------------------------------- | :------------------------------------------- | :--------------- | :-------------------------------------------------------- | :------------------------------- |
| [`adaptive-simd-page-i32`](./src/adaptive-simd-page-i32/README.md)     | Adaptive frozen `i32` pages/columns          | 0.5–44x          | Yes — FOR scan and full decode                            | 14.58 kB (4.63) + 1.84 kB (0.83) |
| [`bitmap`](./src/bitset/README.md)                                     | Growable and fixed dense mutable bitmaps     | 9.8–19.8x        | No — small and point-heavy cases were not measured        | 8.84 kB (2.79) + 0.50 kB (0.26)  |
| [`bit-matrix`](./src/bit-matrix/README.md)                             | Dense Boolean matrix and frozen CSR          | 6.56x dense      | Yes — CSR traversal and small matrices                    | 8.75 kB (3.17) + 0.63 kB (0.41)  |
| [`byte-key-flat-hash`](./src/byte-key-flat-hash/README.md)             | Variable-byte-key map with resident arena    | 2.00x bulk       | Yes — individual gets were 12.5x slower                   | 9.07 kB (3.10) + 1.26 kB (0.73)  |
| [`compressed-string-table`](./src/compressed-string-table/README.md)   | Frozen front-coded byte strings              | 2.00x byte eq    | Yes — decoded strings and random materialization          | 8.06 kB (3.05) + 0.66 kB (0.34)  |
| [`binary-vector-index`](./src/binary-vector-index/README.md)           | Hamming search and exact PDX rerank          | 6.5–9.8x         | Yes — recall depends on candidate count                   | 8.65 kB (3.11) + 0.85 kB (0.43)  |
| [`bit-sliced-column`](./src/bit-sliced-column/README.md)               | Repeated predicates over static `u8` columns | 17.6–29.6x       | No — construction, point reads, and small scans excluded  | 7.83 kB (3.00) + 0.90 kB (0.43)  |
| [`elias-fano-sequence`](./src/elias-fano-sequence/README.md)           | Global/partitioned monotone sequences        | 0.03–11.2x       | Yes — point access, decode, uniform partitioning          | 10.98 kB (3.75) + 1.64 kB (0.86) |
| [`f32-vector`](./src/f32-vector/README.md)                             | Resident Float32 vector operations           | 2–7x             | No — construction and point access were excluded          | 4.60 kB (2.04) + 0.22 kB (0.17)  |
| [`flat-hash`](./src/flat-hash/README.md)                               | Batched `u32`/`u64` hash set/map             | 6.8–12.0x        | Yes — individual `has` and `get` calls                    | 10.10 kB (3.21) + 2.12 kB (0.95) |
| [`flat-hash-fixed16`](./src/flat-hash-fixed16/README.md)               | UUID/hash-keyed map and set                  | 25.6–27.9x bulk  | Yes — numeric or point-key workloads                      | 7.54 kB (2.82) + 0.98 kB (0.64)  |
| [`fingerprint-group16`](./src/fingerprint-group16/README.md)           | SwissTable control groups and tables         | 1.6–4.9x bulk    | Yes — individual probes                                   | 5.52 kB (2.35) + 0.39 kB (0.30)  |
| [`fm-index-bytes`](./src/fm-index-bytes/README.md)                     | Frozen full-text byte search                 | 6.86x count      | Yes — construction, locate, small/frequently updated text | 8.92 kB (3.47) + 2.91 kB (1.31)  |
| [`i32-array`](./src/i32-array/README.md)                               | Resident fixed `i32` arrays                  | 3–7x             | No — one-shot and sub-1K cases were not measured          | 5.22 kB (2.21) + 0.77 kB (0.34)  |
| [`matrix2d`](./src/matrix2d/README.md)                                 | Resident Float32 matrix multiplication       | ~1–9.5x          | No — 4×4 was near parity; BLAS/GPU were not compared      | 6.17 kB (2.51) + 0.37 kB (0.23)  |
| [`matrix3d`](./src/matrix3d/README.md)                                 | Resident batched matrix multiplication       | 5.0–7.3x         | No — only resident generic JS loops were compared         | 6.84 kB (2.67) + 0.45 kB (0.27)  |
| [`packed-delta-uint32-list`](./src/packed-delta-uint32-list/README.md) | Compressed postings and monotone lists       | 0.06–1.4x        | Yes — full decode and lower-bound queries                 | 6.96 kB (2.76) + 1.49 kB (0.88)  |
| [`bit-vector`](./src/rank-select-bitvector/README.md)                  | Frozen `BitVector` / `RankSelectBitmap`      | 1.5–3.0x bulk    | Yes — single-query rank                                   | 7.36 kB (2.68) + 0.95 kB (0.53)  |
| [`roaring-bitmap`](./src/roaring-uint32-set/README.md)                 | Compressed mutable `u32` bitmap              | 2.2–175x         | No — construction and point-heavy cases were not measured | 9.96 kB (3.63) + 1.02 kB (0.49)  |
| [`static-mphf-u32`](./src/static-mphf-u32/README.md)                   | Frozen perfect hash for known `u32` keys     | 1.75x bulk       | Yes — individual lookup and construction                  | 7.27 kB (2.97) + 0.68 kB (0.39)  |
| [`static-mphf-bytes`](./src/static-mphf-bytes/README.md)               | Frozen exact perfect hash for byte keys      | 13.5x vs encode  | Yes — pre-encoded strings and construction                | 10.50 kB (3.95) + 0.84 kB (0.53) |
| [`wavelet-matrix-uint8`](./src/wavelet-matrix-uint8/README.md)         | Rank/range queries over frozen bytes         | 4.8x vs u32      | Yes — direct byte access                                  | 7.92 kB (2.92) + 2.10 kB (0.97)  |
| [`wavelet-matrix-uint32`](./src/wavelet-matrix-uint32/README.md)       | Range statistics over frozen `u32` sequences | 2.2–100x+        | Yes — direct access and exact rank                        | 7.77 kB (2.85) + 2.10 kB (0.97)  |

### Stateless and copy-inclusive kernels

| export                                   | purpose                  | observed speedup | slower than JS in the recorded benchmark? | minified JS + Wasm, raw (gzip)  |
| :--------------------------------------- | :----------------------- | :--------------- | :---------------------------------------- | :------------------------------ |
| [`@mizchi/jsimd`](./src/bytes/README.md) | General byte operations  | 4.9–18.1x        | No — small inputs use JS fallbacks        | 2.32 kB (1.20) + 0.98 kB (0.50) |
| [`endian`](./src/endian/README.md)       | Batched `u32` decoding   | 1.0–2.2x         | No — small inputs were at parity          | 2.21 kB (1.11) + 0.21 kB (0.18) |
| [`json`](./src/json/README.md)           | JSON token-start scanner | 1.1–3.5x         | No — long strings were near parity        | 1.95 kB (1.00) + 0.48 kB (0.28) |

### How to read the numbers

Performance results were recorded on Apple M5 with Node 24 or Deno 2.6 as documented by each linked
feature README. They are workload samples, not cross-feature scores. Resident benchmarks usually
exclude construction and final materialization; copy-inclusive kernels explicitly include boundary
copies. Rerun the linked benchmark on the target engine and data distribution before choosing a
representation.

Build sizes come from isolated Vite 8.2 production fixtures. Each cell reports the minified
JavaScript output and its one independently emitted Wasm asset in kB, with gzip size in parentheses.
The JavaScript raw and gzip figures are both measured after minification. Importing a subpath does
not pull in another feature's Wasm. A real application may share wrapper code or add other runtime
code, so these figures are marginal fixtures rather than a prediction of total bundle size.

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
