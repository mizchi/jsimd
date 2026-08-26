# WaveletMatrixUint32

An immutable binary wavelet matrix over unsigned 32-bit values. It keeps the original sequence order
while supporting value and order-statistics queries over arbitrary subranges.

```ts
import { WaveletMatrixUint32 } from "@mizchi/jsimd/wavelet-matrix-uint32";

using values = WaveletMatrixUint32.from([3, 1, 4, 1, 5, 9, 2, 6, 5]);

values.access(2); // 4
values.rank(1, 4); // 2 occurrences in [0, 4)
values.select(1, 1); // 3: position of the zero-based second occurrence
values.rangeFreq(0, 9, 2, 6); // 5 values in [2, 6)
values.quantile(0, 9, 4); // 4: zero-based fifth-smallest value
values.predecessor(0, 9, 5); // 4: largest value strictly below 5

const output = new Uint32Array(3);
values.quantileMany(
  new Uint32Array([0, 2, 0]),
  new Uint32Array([9, 8, 9]),
  new Uint32Array([0, 3, 8]),
  output,
);
```

Ranges are half-open. `rangeFreq` uses the value interval `[min, max)` and accepts `2^32` as the
exclusive upper bound. `select` returns `-1` for a missing occurrence. `predecessor` is strict and
returns `-1` when the range contains no smaller value. `accessMany`, `rankMany`, and `quantileMany`
keep all 32 level traversals inside one Wasm call and reuse caller-provided output arrays.

Always declare the frozen matrix with `using`. Construction copies the input, and leaving scope
returns its three resident allocations to the module-local power-of-two allocator.

`serialize()` captures all 32 bit levels and rank metadata. Restore with
`WaveletMatrixUint32.fromSnapshot(bytes)` when the matrix is reused across processes or sessions; it
validates the version/kind/shape before allocation. A 65,536-value snapshot was 278,816 bytes and
restored about 63x faster than rebuilding in the recorded resident benchmark.

## Layout and algorithm

Construction performs a stable zero/one partition for each bit from bit 31 down to bit 0. Every
level stores one bit per input value, its zero/one partition boundary, and a cumulative popcount
every 512 bits. Rank scans at most four `v128` blocks beyond that indexed prefix.

All 32 levels are embedded in this entrypoint's own Wasm module. Reusing the separately packaged
`RankSelectBitVector` would emit a second Wasm and would make a point query cross the JS/Wasm
boundary once per level.

The logical resident size is about 4.25 bytes per value: 4 bytes for 32 level bits and 0.25 bytes
for 512-bit rank prefixes, plus 128 bytes of level boundaries. The allocator rounds the three
allocations to power-of-two size classes. Construction additionally uses a temporary 8 bytes per
value and makes 32 stable-partition passes, so this structure is intended for build-once/query-many
workloads.

## Design sources

The binary layout and range-navigation operations follow the wavelet matrix family. The choice to
start with a binary representation and evaluate a 4-ary layout later is informed by
[“Faster Wavelet Tree Queries”](https://arxiv.org/html/2302.09239v2). The 512-bit rank prefix and
128-bit scan are the same Wasm-oriented design used by this package's `RankSelectBitVector`.

## Benchmark

Recorded with Vitest 4.1.11 / Node 24 / Apple M5. Each access/rank sample contains 512 queries.
Quantile samples contain 64 ranges of up to 4,096 values; range-frequency samples execute the same
64 ranges. Timings exclude immutable construction.

|  length | batch access | direct typed access | batch rank | indexed JS rank | batch quantile | copy-sort quantile | rangeFreq | scalar scan |
| ------: | -----------: | ------------------: | ---------: | --------------: | -------------: | -----------------: | --------: | ----------: |
|  16,384 |       258 us |              2.6 us |     386 us |         13.9 us |        37.5 us |            3.86 ms |   81.0 us |    179.6 us |
| 262,144 |       411 us |              2.8 us |     403 us |         19.7 us |        46.9 us |            5.58 ms |   95.4 us |    357.2 us |

The wavelet matrix is not always faster than JavaScript. Direct `Uint32Array` access is roughly
100–150x faster, and a dedicated `Map<value, sorted positions>` answers exact rank about 20x faster
on this mostly-unique dataset. Use those simpler representations when they cover the complete query
set.

The wavelet matrix wins when one compact frozen index must answer arbitrary value ranges and order
statistics: batch quantile was over 100x faster than copying and sorting, and range frequency was
2.2–3.7x faster than scanning. `select` performs a reverse traversal with a binary search at each
level and should not be treated as a blanket performance win without workload-specific measurement.

```sh
pnpm bench:wavelet-matrix-uint32
pnpm bench:record:wavelet-matrix-uint32
pnpm bench:compare:wavelet-matrix-uint32
```

## Standalone build size

The isolated Vite fixture emits one 2.10 kB Wasm asset (0.97 kB gzip) and an 11.63 kB minified JS
wrapper (4.19 kB gzip). No other jsimd Wasm module is emitted.

Vitest baseline JSON and complete sources live in
[`experiments/wavelet-matrix-uint32`](../../experiments/wavelet-matrix-uint32). Cross-structure
snapshot results are in [`experiments/snapshots`](../../experiments/snapshots/README.md).

Files:

- `mod.ts`: immutable TypeScript contract, validation, batching, allocator ownership
- `kernels.wat`: construction, rank navigation, selection, quantile, and batch kernels
- `kernels.d.wasm.ts`: typed Wasm module contract
- `kernels.wasm`: generated, stripped, validated, and Git-ignored
