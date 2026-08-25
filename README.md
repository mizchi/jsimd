# @mizchi/jsimd

Small prebuilt WebAssembly SIMD kernels for byte-heavy JavaScript hot paths. The initial
implementation is derived from the scalar/SIMD byte scanners in `moonbitlang/core` and is measured
against MoonBit's JS backend.

```ts
import {
  bytesEqual,
  findByte,
  findNonAscii,
  indexOfSubarray,
  jsonTokenStarts,
  lexicalCompare,
  reverseFindByte,
} from "@mizchi/jsimd";
import { FixedBitSet } from "@mizchi/jsimd/bitset";
import { SimdFloat32Vector } from "@mizchi/jsimd/f32-vector";

const bytes = new Uint8Array([1, 2, 3]);
findByte(bytes, 2);
reverseFindByte(bytes, 2);
findNonAscii(bytes);
bytesEqual(bytes, bytes.slice());
lexicalCompare(bytes, new Uint8Array([1, 2, 4]));
indexOfSubarray(bytes, new Uint8Array([2, 3]));
jsonTokenStarts(new TextEncoder().encode('{"ok":true}'));

const active = FixedBitSet.from(1_000_000, [1, 10, 999_999]);
const selected = FixedBitSet.from(1_000_000, [10, 20]);
active.intersectionCount(selected); // 1
active.unionWith(selected); // mutates active without copying through JS
active.dispose();
selected.dispose();

const x = SimdFloat32Vector.from(new Float32Array([1, 2, 3, 4]));
const y = SimdFloat32Vector.from(new Float32Array([2, 4, 6, 8]));
x.dot(y); // 60
x.addScaled(y, 0.5); // x += 0.5 * y
x.dispose();
y.dispose();
```

The package uses direct Wasm ES module imports supported by current Vite and Deno. Module loading
performs initialization; exported operations are synchronous. Lazy initialization is intentionally
deferred.

The `.wasm` import is typed by the adjacent `dist/jsimd.d.wasm.ts`, following Vite's
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

## FixedBitSet

`FixedBitSet` keeps its aligned, padded backing words in Wasm memory. `unionWith`, `intersectWith`,
`differenceWith`, and `symmetricDifferenceWith` use 128-bit operations without copying through JS.
`countOnes` and `intersectionCount` use `i8x16.popcnt`. Point operations (`insert`, `remove`, and
`has`) access the same memory directly from JavaScript.

The API and workload selection follow Rust's `fixedbitset`: fixed capacity, dense backing words,
in-place set algebra, and cardinality operations. It intentionally does not replace JavaScript's
general-purpose `Set`; the useful case is repeated bulk operations over a fixed integer universe.

On Deno 2.6.4 / Apple M5 with a 4,194,304-bit universe (density 1/7 and 1/11):

| operation          | Wasm SIMD | scalar `Uint32Array` | `Set<number>` |  BigInt |
| ------------------ | --------: | -------------------: | ------------: | ------: |
| intersection count |   38.9 us |             380.1 us |       11.2 ms |     n/a |
| in-place union     |   15.3 us |             302.6 us |           n/a | 48.2 us |

BigInt union is native and compact to write, but produces a new immutable large integer. The SIMD
operation mutates reusable storage. Benchmark averages include runtime variance; run
`deno bench -A --filter bitset` on the target engine before choosing an implementation.

Wasm linear memory cannot shrink, but `dispose()` returns the block to a power-of-two free list for
reuse with bounded size-class fragmentation. `FixedBitSet.allocatorStats()` exposes live, free,
reserved, and physical memory byte counts. Using an object after disposal throws; repeated disposal
is safe. `using`/`Symbol.dispose` is also supported.

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

```sh
just test
just bench
```

Implemented kernels: fixed bitsets, forward/reverse byte search, subarray search, byte
equality/lexicographical comparison, ASCII validation, and UTF-8 JSON token-start extraction.
Planned kernels include UTF-16 validation. Each kernel must beat the best relevant JavaScript
builtin or scalar reference after including JS/Wasm copy and call overhead. See `CORE_PATTERNS.md`
for the MoonBit source mapping.
