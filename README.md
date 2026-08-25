# @mizchi/jsimd

Small prebuilt WebAssembly SIMD kernels for data-parallel JavaScript hot paths. The initial
implementation is derived from the scalar/SIMD byte scanners in `moonbitlang/core` and is measured
against MoonBit's JS backend.

```ts
import {
  bytesEqual,
  findByte,
  findNonAscii,
  indexOfSubarray,
  lexicalCompare,
  reverseFindByte,
} from "@mizchi/jsimd";
import { BitSet, FixedBitSet } from "@mizchi/jsimd/bitset";
import { BitSlicedColumnU8, BitSliceMask } from "@mizchi/jsimd/bit-sliced-column";
import { decodeUint32BE } from "@mizchi/jsimd/endian";
import { SimdFloat32Vector } from "@mizchi/jsimd/f32-vector";
import { FlatHashMapU32U32, FlatHashSetU32 } from "@mizchi/jsimd/flat-hash";
import { SimdInt32Array } from "@mizchi/jsimd/i32-array";
import { jsonTokenStarts } from "@mizchi/jsimd/json";
import { SimdMatrix2D } from "@mizchi/jsimd/matrix2d";
import { SimdMatrix3D } from "@mizchi/jsimd/matrix3d";
import { RankSelectBitVectorBuilder } from "@mizchi/jsimd/rank-select-bitvector";
import { RoaringUint32Set } from "@mizchi/jsimd/roaring-uint32-set";
import { PackedDeltaUint32List } from "@mizchi/jsimd/packed-delta-uint32-list";

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
```

The package uses direct Wasm ES module imports supported by current Vite and Deno. Module loading
performs initialization; exported operations are synchronous. Lazy initialization is intentionally
deferred.

Each entrypoint is self-contained under `src/<name>/`, with its own TypeScript API, README, WAT
source, Wasm type declaration, and generated Wasm binary:

- [`src/bytes`](./src/bytes/README.md) — byte search, comparison, ASCII, and subarray scanning
- [`src/bitset`](./src/bitset/README.md) — growable and fixed-universe SIMD bitsets
- [`src/bit-sliced-column`](./src/bit-sliced-column/README.md) — nullable bit-sliced predicates and
  resident masks
- [`src/endian`](./src/endian/README.md) — batched endian decoding
- [`src/f32-vector`](./src/f32-vector/README.md) — resident Float32 dot product and AXPY
- [`src/flat-hash`](./src/flat-hash/README.md) — typed `u32` SIMD flat hash set and map
- [`src/i32-array`](./src/i32-array/README.md) — fixed-length resident Int32 bulk operations
- [`src/json`](./src/json/README.md) — UTF-8 JSON token-start scanning
- [`src/matrix2d`](./src/matrix2d/README.md) — resident row-major Float32 matrix operations
- [`src/matrix3d`](./src/matrix3d/README.md) — resident batch-major Float32 matrix operations
- [`src/rank-select-bitvector`](./src/rank-select-bitvector/README.md) — immutable rank/select index
- [`src/roaring-uint32-set`](./src/roaring-uint32-set/README.md) — compressed Uint32 set operations
- [`src/packed-delta-uint32-list`](./src/packed-delta-uint32-list/README.md) — frozen compressed
  monotone Uint32 lists

The package is distributed as one npm package with subpath exports. The Wasm binaries remain
separate, so bundlers only include the entrypoints that are imported.

Each `.wasm` import is typed by an adjacent `kernels.d.wasm.ts`, following Vite's
`allowArbitraryExtensions` convention. Consumers get typed Wasm exports without a generated JS
loader. The wrapper uses `Uint8Array#indexOf` below 128 bytes; in the initial Deno benchmark the
copy-inclusive SIMD path was about 4.7x faster for a 4 KiB miss scan (0.37 us vs 1.8 us).

Higher-level kernels amortize the boundary particularly well. On Deno 2.6.4 / Apple M5,
`indexOfSubarray` took 0.94 us versus 17.0 us for the scalar reference on a 4 KiB miss, and
`lexicalCompare` took 0.69 us versus 4.1 us for equal 4 KiB inputs.

`jsonTokenStarts` performs classification, quote/backslash state transitions, string masking, atom
boundary detection, and position emission inside Wasm. It was 3.5x faster on a 38 KiB mixed JSON
sample (56 us vs 196 us), 3.0x on a punctuation-dense 60 KiB sample, and roughly even on a 75 KiB
long-string sample where both implementations still walk every byte.

## BitSet and FixedBitSet

`FixedBitSet` keeps its aligned, padded backing words in Wasm memory. `unionWith`, `intersectWith`,
`differenceWith`, and `symmetricDifferenceWith` use 128-bit operations without copying through JS.
`countOnes` and `intersectionCount` use `i8x16.popcnt`. Point operations (`insert`, `remove`, and
`has`) access the same memory directly from JavaScript.

The API and workload selection follow Rust's `fixedbitset`: fixed capacity, dense backing words,
in-place set algebra, and cardinality operations. It intentionally does not replace JavaScript's
general-purpose `Set`; the useful case is repeated bulk operations over a fixed integer universe.
`BitSet` shares the same storage and kernels but grows geometrically. The fixed name remains useful:
`FixedBitSet` makes the integer universe part of the contract and rejects mismatched capacities.

On Deno 2.6.4 / Apple M5 with a 4,194,304-bit universe (density 1/7 and 1/11):

| operation          | Wasm SIMD | scalar `Uint32Array` | `Set<number>` |  BigInt |
| ------------------ | --------: | -------------------: | ------------: | ------: |
| intersection count |   38.9 us |             380.1 us |       11.2 ms |     n/a |
| in-place union     |   15.3 us |             302.6 us |           n/a | 48.2 us |

BigInt union is native and compact to write, but produces a new immutable large integer. The SIMD
operation mutates reusable storage. Benchmark averages include runtime variance; run
`deno bench -A --filter bitset` on the target engine before choosing an implementation.

Wasm linear memory cannot shrink, but leaving a `using` scope returns the block to a power-of-two
free list for reuse with bounded size-class fragmentation. `FixedBitSet.allocatorStats()` exposes
live, free, reserved, and physical memory byte counts. Using an object after scope disposal throws.

## SIMD Float32 vectors

`SimdFloat32Vector` is a Wasm-resident numeric vector, rather than a replacement for JavaScript
array access. `dot` and in-place `addScaled` (AXPY) cross the JS/Wasm boundary once per complete
operation. Input is copied once by `from`; repeated operations do not copy through JS.

On Deno 2.6.4 / Apple M5:

|  elements | resident SIMD dot | scalar `Float32Array` dot | resident SIMD AXPY | scalar AXPY |
| --------: | ----------------: | ------------------------: | -----------------: | ----------: |
|        16 |            6.1 ns |                   12.8 ns |             6.0 ns |     13.7 ns |
|     1,024 |          151.9 ns |                  651.0 ns |           108.5 ns |    685.8 ns |
|   262,144 |           43.5 us |                  175.8 us |            28.6 us |    186.9 us |
| 4,194,304 |            855 us |                    3.1 ms |             531 us |      3.1 ms |

These numbers model reuse of resident vectors and exclude construction. For one-shot operations, the
copy-inclusive path must be benchmarked separately. SIMD reduction also changes floating-point
association, so `dot` is numerically close to, but not bit-identical with, a sequential JS sum.

Both stateful APIs are subpath exports backed by separate Wasm binaries. Importing only
`@mizchi/jsimd/bitset` does not bundle the byte or Float32-vector Wasm. `just check` verifies this
with a Vite production fixture and fails unless exactly the bitset Wasm asset is emitted.

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
`wasm-tools validate --features simd`, ignored by Git, and included in the npm tarball produced
after a build. The hand-written kernels do not require Binaryen; development only requires
`wasm-tools` on `PATH`.

Implemented kernels: fixed bitsets, forward/reverse byte search, subarray search, byte
equality/lexicographical comparison, ASCII validation, and UTF-8 JSON token-start extraction.
Planned kernels include UTF-16 validation. Each kernel must beat the best relevant JavaScript
builtin or scalar reference after including JS/Wasm copy and call overhead. See `CORE_PATTERNS.md`
for the MoonBit source mapping.
