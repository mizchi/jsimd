# Radix sort block experiment

Status: admitted as `@mizchi/jsimd-olap/radix-order-u32` after metadata-backed validation.

This experiment tests reusable Wasm-resident LSD radix sorting for unsigned `u32` and `u64` blocks.
Each byte is one stable counting-sort pass, so `u32` always takes four passes and `u64` always takes
eight. A 256-entry histogram and an equally sized scratch block are reused across calls.

```ts
import { RadixSortBlockWorkspace } from "./workspace.ts";

await using workspace = await RadixSortBlockWorkspace.create(1 << 20);
const output = new Uint32Array(input.length);
workspace.sortU32Into(input, output);
```

The Wasm SIMD contribution is deliberately small: `v128.store` clears the histogram 16 bytes at a
time. WebAssembly SIMD has no scatter instruction, so histogram construction, prefix sums, and
stable scattering are scalar Wasm. The measured advantage comes primarily from the fixed `O(kN)`
byte-radix layout, not from pretending that the complete algorithm is vectorized.

## Recorded result

Apple M5 / Deno 2.6.4, 5 warmups and median of 11 samples with three operations per sample. Every
row restores the same input before sorting. The JS baseline is native `TypedArray.prototype.sort()`;
the materialized Wasm rows include both input and output copies.

| type / input                  |    values |  JS sort | Wasm materialized | result       |
| :---------------------------- | --------: | -------: | ----------------: | :----------- |
| random `u32`                  |     4,096 | 0.023 ms |          0.021 ms | 1.07x faster |
| random `u32`                  |    65,536 | 0.799 ms |          0.328 ms | 2.44x faster |
| random `u32`                  | 1,048,576 | 15.75 ms |           5.51 ms | 2.86x faster |
| random `u64`                  |     4,096 | 0.022 ms |          0.054 ms | 2.44x slower |
| random `u64`                  |    65,536 | 0.896 ms |          0.617 ms | 1.45x faster |
| random `u64`                  | 1,048,576 | 15.83 ms |          11.04 ms | 1.43x faster |
| already sorted `u32`          | 1,048,576 | 0.597 ms |          18.41 ms | 30.8x slower |
| 256-value-cardinality `u32`   | 1,048,576 |  5.68 ms |           6.28 ms | 1.11x slower |
| high-nibble-partitioned `u32` | 1,048,576 | 16.85 ms |           5.70 ms | 2.96x faster |

Times in the table are rounded from the recorded samples and should be read with the ratios, not as
cross-machine constants. Raw samples are in [`benchmarks/u32-u64.json`](./benchmarks/u32-u64.json).

The stable key-plus-row-ID path measures a physical `ORDER BY key` boundary: both paths produce
caller-owned sorted keys and row IDs. The strongest JS baseline packs `(key << 32) | rowId` into a
`BigUint64Array`, invokes its native sort, and unpacks both outputs. A conventional stable
row-ID/comparator sort is also recorded but is not used as the primary baseline.

|    values | JS packed `u64` | Wasm key + row ID | result       |
| --------: | --------------: | ----------------: | :----------- |
|    65,536 |        0.950 ms |          0.401 ms | 2.37x faster |
| 1,048,576 |        17.18 ms |           7.47 ms | 2.30x faster |

`orderU32Into()` adds an automatic physical planner. It scans ordering and a bounded distinct-value
sample, then selects an already-sorted copy, native packed sort, or Wasm radix. The table compares
that complete selection cost against an oracle JS path that already knows the best strategy.

| 1,048,576-value input | metadata path    | auto vs JS | metadata vs JS |
| :-------------------- | :--------------- | ---------: | -------------: |
| uniform random        | Wasm radix       |      1.59x |          2.18x |
| radix-partitioned     | Wasm radix       |      1.55x |          2.01x |
| already sorted        | direct copy      |      0.54x |          1.03x |
| 256-value cardinality | native packed JS |      0.85x |          0.99x |

The metadata rows use facts persisted by `SchemaEngine`: page `first`/`last`, adjacent inversion
count, and the existing min/max value range. Ingestion and the manifest-only metadata read are
outside the repeated physical operation, as they are for other resident OLAP planning metadata.

## Admission decision

The kernel is worth keeping as positive evidence, but it is not a general replacement for native
typed-array sorting:

- use it only for large, unsorted unsigned integer blocks where all radix passes are repaid;
- keep JS sort for small, already sorted, nearly sorted, or low-cardinality inputs;
- byte-radix scattering can have especially poor cache locality on already sorted keys, while the
  engine-native sort detects or exploits that order;
- construction and materialization are included, but workspace creation is intentionally excluded
  because the intended OLAP path reuses a resident workspace;
- the stable u32 payload path proves row-ID permutation can win, and the automatic planner prevents
  catastrophic fallback choices, but discovering facts the oracle already knows still costs one
  input pass;
- the admitted public operator consumes sortedness/cardinality metadata from the columnar planner
  and safely falls back to native packed sorting for legacy manifests without those facts.

Only the stable u32 key-plus-row-ID operator was promoted. The generic key-only u32/u64 workspace
and runtime-inspection planner remain experimental because their unconditional APIs still include
the recorded losing distributions.

```sh
just test-radix-sort-block
just bench-radix-sort-block
just bench-record-radix-sort-block
```
