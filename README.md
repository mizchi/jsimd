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

```ts
import {
  bytesEqual,
  findByte,
  findNonAscii,
  indexOfSubarray,
  lexicalCompare,
  reverseFindByte,
} from "@mizchi/jsimd";
import { AdaptiveSimdPageI32, SimdPageMask } from "@mizchi/jsimd/adaptive-simd-page-i32";
import { BitSet, FixedBitSet } from "@mizchi/jsimd/bitset";
import { BinaryVectorIndex } from "@mizchi/jsimd/binary-vector-index";
import { BitSlicedColumnU8, BitSliceMask } from "@mizchi/jsimd/bit-sliced-column";
import { decodeUint32BE } from "@mizchi/jsimd/endian";
import { EliasFanoSequence } from "@mizchi/jsimd/elias-fano-sequence";
import { SimdFloat32Vector } from "@mizchi/jsimd/f32-vector";
import { FlatHashMapU32U32, FlatHashSetU32 } from "@mizchi/jsimd/flat-hash";
import { SimdInt32Array } from "@mizchi/jsimd/i32-array";
import { jsonTokenStarts } from "@mizchi/jsimd/json";
import { SimdMatrix2D } from "@mizchi/jsimd/matrix2d";
import { SimdMatrix3D } from "@mizchi/jsimd/matrix3d";
import { RankSelectBitVectorBuilder } from "@mizchi/jsimd/rank-select-bitvector";
import { RoaringUint32Set } from "@mizchi/jsimd/roaring-uint32-set";
import { StaticMphfU32 } from "@mizchi/jsimd/static-mphf-u32";
import { PackedDeltaUint32List } from "@mizchi/jsimd/packed-delta-uint32-list";
import { WaveletMatrixUint32 } from "@mizchi/jsimd/wavelet-matrix-uint32";

const bytes = new Uint8Array([1, 2, 3]);
findByte(bytes, 2);
reverseFindByte(bytes, 2);
findNonAscii(bytes);
bytesEqual(bytes, bytes.slice());
lexicalCompare(bytes, new Uint8Array([1, 2, 4]));
indexOfSubarray(bytes, new Uint8Array([2, 3]));
jsonTokenStarts(new TextEncoder().encode('{"ok":true}'));
decodeUint32BE(new Uint8Array([0x01, 0x23, 0x45, 0x67]));

using active = FixedBitSet.from(1_000_000, [1, 10, 999_999]);
using selected = FixedBitSet.from(1_000_000, [10, 20]);
active.intersectionCount(selected); // 1
active.unionWith(selected); // mutates active without copying through JS

using discovered = BitSet.from([1, 10, 999_999]);
discovered.insert(2_000_000); // grows automatically

using x = SimdFloat32Vector.from(new Float32Array([1, 2, 3, 4]));
using y = SimdFloat32Vector.from(new Float32Array([2, 4, 6, 8]));
x.dot(y); // 60
x.addScaled(y, 0.5); // x += 0.5 * y

using values = SimdInt32Array.from([5, -7, 11, 13, 2]);
values.sum(); // 24
values.min(); // -7

using matrixLeft = SimdMatrix2D.from(2, 2, [1, 2, 3, 4]);
using matrixRight = SimdMatrix2D.from(2, 2, [5, 6, 7, 8]);
using matrixOutput = matrixLeft.multiply(matrixRight);

using batchLeft = SimdMatrix3D.from(2, 2, 2, [1, 2, 3, 4, 2, 0, 1, 2]);
using batchRight = SimdMatrix3D.from(2, 2, 2, [5, 6, 7, 8, 1, 3, 4, 2]);
using batchOutput = batchLeft.batchMultiply(batchRight);

const rankBuilder = new RankSelectBitVectorBuilder(1_000);
rankBuilder.insert(1).insert(10).insert(999);
using rankBits = rankBuilder.freeze();
rankBits.rank1(500); // 2

using roaringLeft = RoaringUint32Set.from([1, 10, 65_536]);
using roaringRight = RoaringUint32Set.from([10, 65_536, 70_000]);
roaringLeft.andCardinality(roaringRight); // 2

using packedLeft = PackedDeltaUint32List.from([1, 3, 9, 100, 1_000]);
using packedRight = PackedDeltaUint32List.from([3, 10, 100, 2_000]);
const packedIntersection = new Uint32Array(4);
packedLeft.intersectInto(packedRight, packedIntersection); // 2: [3, 100]

using ids = FlatHashSetU32.from([1, 3, 5]);
using offsets = FlatHashMapU32U32.from([[1, 100], [3, 300]]);
const idQueries = new Uint32Array([0, 1, 3]);
const idPresent = new Uint8Array(idQueries.length);
ids.lookupMany(idQueries, idPresent);

using statusColumn = BitSlicedColumnU8.from(new Uint8Array([1, 4, 7, 10]), 4);
using statusMask = new BitSliceMask(statusColumn.length);
statusColumn.between(4, 10, statusMask);

using orderedValues = WaveletMatrixUint32.from([3, 1, 4, 1, 5, 9]);
orderedValues.quantile(0, orderedValues.length, 3); // 4

using monotoneOffsets = EliasFanoSequence.from([1, 1, 3, 10, 100]);
monotoneOffsets.nextGEQ(4); // 10

using page = AdaptiveSimdPageI32.from([-3, 1, 4, 1, 5, 9, 2, 6]);
using pageSelection = new SimdPageMask(page.length);
page.scanBetween(1, 6, pageSelection);
pageSelection.toIndices(); // [1, 2, 3, 4, 6]

using staticIds = StaticMphfU32.from([10, 20, 30, 40]);
const staticQueries = new Uint32Array([10, 99, 40]);
const denseIds = new Int32Array(staticQueries.length);
staticIds.lookupMany(staticQueries, denseIds); // 2

using binaryIndex = BinaryVectorIndex.fromSignatures([new Uint8Array([0]), new Uint8Array([255])]);
const hamming = new Uint32Array(binaryIndex.length);
binaryIndex.distanceMany(new Uint8Array([0]), hamming);
```

The package uses direct Wasm ES module imports supported by current Vite and Deno. Module loading
performs initialization; exported operations are synchronous. Lazy initialization is intentionally
deferred.

## Implementation guide

Each link below opens the feature README with its complete API, algorithm and literature sources,
benchmark setup, and reproduction commands. The summary deliberately includes measured losses: this
package does not claim that crossing the JavaScript/Wasm boundary is always faster.

Owning structures keep data in Wasm linear memory and should be declared with `using`. They are a
good fit when several bulk operations reuse resident data. Native arrays and collections usually
remain the better choice for small inputs, one-shot work, point access, or workloads that repeatedly
materialize complete results back into JavaScript.

### Data structures

| export                                                                 | representation and intended workload                                                                                                                        | measured strength                                                                                                                     | when JavaScript or a simpler representation wins                                                                                                                    | isolated Vite output, raw (gzip)         |
| :--------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :--------------------------------------- |
| [`adaptive-simd-page-i32`](./src/adaptive-simd-page-i32/README.md)     | Frozen pages of at most 256 `i32` values; chooses Constant, frame-of-reference (FOR), or Raw and keeps selection masks resident.                            | Constant sum was 44x faster, Raw sum 11x, and Raw scan 1.3x than `Int32Array` loops. FOR reduces a tested page from 1,024 B to 320 B. | FOR range scan was 1.9x slower; FOR decode was about 17x slower than native typed-array copying. Keep `Int32Array` when full reads dominate.                        | JS 10.37 kB (3.72) + Wasm 1.84 kB (0.83) |
| [`bitset`](./src/bitset/README.md)                                     | Dense mutable integer sets. `FixedBitSet` enforces one universe; `BitSet` grows geometrically. Set algebra and popcount stay resident.                      | At 4M bits, intersection count was 9.8x and in-place union 19.8x faster than scalar `Uint32Array`.                                    | Small or point-heavy sets should use `Set<number>` or BigInt. Growth copies storage, and dense allocation is wasteful for sparse universes.                         | JS 8.84 kB (2.80) + Wasm 0.50 kB (0.26)  |
| [`binary-vector-index`](./src/binary-vector-index/README.md)           | Frozen equal-width binary signatures; exhaustive Hamming scans use XOR and popcount.                                                                        | A resident scan over 65,536 256-bit signatures was 7.82x faster than scalar JS. Signatures use 1/32 of the source Float32 payload.    | Construction and output copying erase gains for one-shot scans. Sign quantization changes recall, and `topK` currently sorts all distances in JS.                   | JS 6.33 kB (2.64) + Wasm 0.22 kB (0.18)  |
| [`bit-sliced-column`](./src/bit-sliced-column/README.md)               | Mostly-static nullable `u8` column stored as one bitmap per bit, with composable resident selection masks.                                                  | Equality/range scans over 4M rows were 17.6–29.6x faster than scalar `Uint8Array` scans.                                              | Construction transposes all values; point reads and small scans are poor fits. At eight bits, data plus validity uses more space than `Uint8Array`.                 | JS 7.83 kB (3.00) + Wasm 0.90 kB (0.43)  |
| [`elias-fano-sequence`](./src/elias-fano-sequence/README.md)           | Frozen non-decreasing `u32` sequence with packed lower bits and a rank-indexed unary upper vector. Supports access and ordered queries without full decode. | Used 0.46–0.77 B/value and gave about 2.5x faster point access than PackedDelta; batched rank was near typed-array binary search.     | Direct `Uint32Array` access was about 5x faster and native copy about 36x faster than full decode. PackedDelta decodes sequentially faster.                         | JS 8.24 kB (3.09) + Wasm 1.64 kB (0.86)  |
| [`f32-vector`](./src/f32-vector/README.md)                             | Fixed Wasm-resident Float32 vectors for repeated dot product and in-place AXPY.                                                                             | Resident operations were about 2–7x faster than scalar `Float32Array` loops from 16 to 4M elements.                                   | Point access and one-shot operations should stay in JS because `from` copies the input. SIMD reduction changes floating-point association.                          | JS 4.60 kB (2.04) + Wasm 0.22 kB (0.17)  |
| [`flat-hash`](./src/flat-hash/README.md)                               | Mutable `u32` set/map with SwissTable-style 16-byte control groups, fingerprints, tombstones, and bulk APIs.                                                | Batched lookup and rebuild workloads were 5.9–9.9x faster than JS collections in the recorded large table.                            | For 1,024 individual calls, JS `Set` was 1.63x and `Map` 3.37x faster. It does not support arbitrary JS keys or values.                                             | JS 6.84 kB (2.66) + Wasm 1.27 kB (0.72)  |
| [`i32-array`](./src/i32-array/README.md)                               | Fixed resident signed array with bulk sum/min/max/equality and in-place addition.                                                                           | Reused arrays from 1K to 4M elements were roughly 3–7x faster than equivalent typed-array loops.                                      | Individual access is not accelerated. Below roughly 1K elements or for a one-off operation, the initial copy can dominate.                                          | JS 5.22 kB (2.21) + Wasm 0.77 kB (0.34)  |
| [`matrix2d`](./src/matrix2d/README.md)                                 | Fixed row-major Float32 matrix with four-lane row padding, resident elementwise operations, and multiplication.                                             | Resident multiplication was about 4.6–9.5x faster than generic JS loops from 16×16 to 256×256.                                        | 4×4 was near parity. Specialized unrolled graphics code, native BLAS, and GPU workloads are outside this comparison. Construction and materialization are excluded. | JS 6.17 kB (2.51) + Wasm 0.37 kB (0.23)  |
| [`matrix3d`](./src/matrix3d/README.md)                                 | Fixed batch-major Float32 tensor for `[B,M,K] × [B,K,N]` multiplication in one Wasm call.                                                                   | Recorded batches were 5.0–7.3x faster than equivalent generic JS loops.                                                               | Inputs and output must already be resident. It has no broadcasting and is not a replacement for BLAS or WebGPU. Point access remains a JS-array strength.           | JS 6.84 kB (2.67) + Wasm 0.45 kB (0.27)  |
| [`packed-delta-uint32-list`](./src/packed-delta-uint32-list/README.md) | Frozen strictly increasing `u32` list using Stream VByte plus 128-value checkpoints; aimed at postings and adjacency lists.                                 | Used 1.31 B/value in the benchmark and reusable intersection was 1.40x faster than an uncompressed merge.                             | `Uint32Array` full copy was 15.7–17.1x faster and lower-bound batches 2.9–3.3x faster. Do not choose it for decode-heavy access.                                    | JS 6.96 kB (2.76) + Wasm 1.49 kB (0.88)  |
| [`rank-select-bitvector`](./src/rank-select-bitvector/README.md)       | Frozen bitvector with a cumulative count every 512 bits; supports rank, select, and neighboring-one queries.                                                | Batches of 1,024 ranks were at least 1.51x faster and selects 1.71–3.0x faster than indexed JS. Index overhead is 0.78%.              | Single-query rank was slightly slower than JS in every measured size; single select was near parity. Batch queries are the intended API.                            | JS 7.37 kB (2.69) + Wasm 0.95 kB (0.53)  |
| [`roaring-uint32-set`](./src/roaring-uint32-set/README.md)             | Mutable Roaring-style `u32` set: sorted `u16` array containers through 4,096 entries and 8 KiB bitmap containers above it.                                  | Dense intersection cardinality was about 175x faster than a sorted typed-array merge; sparse cases were 2.2–10.9x faster.             | Construction was excluded, and point-heavy or tiny sets need workload-specific measurement. Run containers and portable Roaring serialization are not implemented.  | JS 9.96 kB (3.63) + Wasm 1.02 kB (0.49)  |
| [`static-mphf-u32`](./src/static-mphf-u32/README.md)                   | Frozen minimal perfect hash for a known `u32` key set; dense IDs plus 16-bit membership fingerprints.                                                       | Batched lookup was 1.75x faster than `Set` while using 3 logical B/key versus FlatHash's 10 B/key.                                    | Individual lookup was about 8x slower than `Set`; construction was about 42x slower than FlatHash. Unknown keys have a roughly `1/2^16` false-positive chance.      | JS 7.27 kB (2.97) + Wasm 0.68 kB (0.39)  |
| [`wavelet-matrix-uint32`](./src/wavelet-matrix-uint32/README.md)       | Frozen binary wavelet matrix preserving order while answering range frequency, quantile, rank, select, and predecessor queries.                             | Batch quantile was over 100x faster than copy-and-sort; range frequency was 2.2–3.7x faster than scalar scanning.                     | Direct typed access was 100–150x faster and a dedicated positions map answered exact rank about 20x faster. Construction makes 32 passes and uses temporary memory. | JS 7.77 kB (2.85) + Wasm 2.10 kB (0.97)  |

### Stateless and copy-inclusive kernels

| export                                   | operation                                                                                                                                | measured strength                                                                        | when JavaScript wins or reaches parity                                                                                             | isolated Vite output, raw (gzip)        |
| :--------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------- |
| [`@mizchi/jsimd`](./src/bytes/README.md) | Byte search, reverse search, ASCII detection, equality, lexical comparison, and subarray search. Wrappers include scratch-memory copies. | On 4 KiB inputs, measured speedups ranged from 4.9x to 18.1x.                            | Copy and call overhead dominate very small inputs, so the wrappers select native JS paths below operation-specific thresholds.     | JS 2.32 kB (1.20) + Wasm 0.98 kB (0.50) |
| [`endian`](./src/endian/README.md)       | Batched `u32` big/little-endian decoding; big-endian uses SIMD byte shuffle for larger inputs.                                           | Big-endian inputs from 512 B to 16 KiB were 1.3–2.2x faster than `DataView`.             | At 64–256 B it was at parity; little-endian uses a native typed-array path on little-endian hosts.                                 | JS 2.21 kB (1.11) + Wasm 0.21 kB (0.18) |
| [`json`](./src/json/README.md)           | UTF-8 JSON token-start scanner with SIMD classification and an in-Wasm string/escape/atom state machine.                                 | Mixed and punctuation-dense 38–60 KiB inputs were 3.0–3.5x faster than the scalar lexer. | A 75 KiB long-string input was only 1.1x faster because both paths inspect nearly every byte; small inputs also pay copy overhead. | JS 1.95 kB (1.00) + Wasm 0.48 kB (0.28) |

### How to read the numbers

Performance results were recorded on Apple M5 with Node 24 or Deno 2.6 as documented by each linked
feature README. They are workload samples, not cross-feature scores. Resident benchmarks usually
exclude construction and final materialization; copy-inclusive kernels explicitly include boundary
copies. Rerun the linked benchmark on the target engine and data distribution before choosing a
representation.

Build sizes come from isolated Vite 8.2 production fixtures. Each cell reports minified JavaScript
and its one independently emitted Wasm asset in kB, with gzip size in parentheses. Importing a
subpath does not pull in another feature's Wasm. A real application may share wrapper code or add
other runtime code, so these figures are marginal fixtures rather than a prediction of total bundle
size.

The package is distributed as one npm package with subpath exports. npm releases contain compiled
JavaScript and adjacent declarations; consumers do not need TypeScript runtime transformation for
files under `node_modules`. Each `.wasm` import is typed by an adjacent `kernels.d.wasm.ts`,
following Vite's `allowArbitraryExtensions` convention, without a generated environment-specific
loader.

## Development

The short data-structure roadmap is in [`ROADMAP.md`](./ROADMAP.md). Concrete implementation tasks,
dependency tracks, and benchmark gates are maintained in [`TODO.md`](./TODO.md).

```sh
pnpm install
just build
just test
just bench
```

`just build` compiles each `src/<name>/kernels.wat` into its adjacent `kernels.wasm`. Generated Wasm
files have custom sections removed with `wasm-tools strip -a`, are checked with
`wasm-tools validate --features simd`, and are ignored by Git. `just build-package` emits the npm
payload into `dist/`: compiled JavaScript, declarations, feature documentation, WAT sources, and the
corresponding stripped Wasm binaries. The hand-written kernels do not require Binaryen; development
only requires `wasm-tools` on `PATH`.

Implemented and planned work is tracked in [`TODO.md`](./TODO.md). A kernel is retained only when a
documented workload justifies its Wasm boundary and bundle cost against the best relevant JavaScript
builtin or scalar reference.
