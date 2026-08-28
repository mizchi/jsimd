# Worker-local blocked Bloom experiment

Status: negative admission result; not exported from any package.

This experiment tests a phase-owned concurrent Bloom design without atomic `v128` operations. Four
persistent Workers build private 128-bit-blocked filters over disjoint key ranges. The coordinator
then uses the existing `ShardedBitmap` SIMD OR reduction to publish one immutable query filter.

```ts
import { ParallelBlockedBloomFilterU32 } from "./pipeline.ts";

await using filter = await ParallelBlockedBloomFilterU32.create({
  maxBuildKeys: 1 << 20,
  maxQueryKeys: 1 << 20,
  workerCount: 4,
  targetBitsPerKey: 10,
});
await filter.replace(buildKeys);
filter.mayContainMany(probeKeys, candidateMask);
```

`replace()` is the phase boundary. Each Worker exclusively owns one cache-line-isolated shard,
clears and rebuilds it without atomics, and releases it before reduction. Queries see only the
completed OR result. This does not promise a snapshot while a replacement is running.

## Recorded result

Apple M5 / Deno 2.6.4, 1,048,576 build keys, 1,048,576 query keys, 10 bits/key, four persistent
Workers, 10 warmups and median of 11 samples with two operations per sample:

| operation                 | serial Bloom | Worker-local + SIMD OR | result       |
| :------------------------ | -----------: | ---------------------: | :----------- |
| rebuild only              |      3.05 ms |                1.24 ms | 2.46x faster |
| refresh + exact, 10% hits |     17.42 ms |               16.13 ms | 1.08x faster |
| refresh + exact, 50% hits |     31.02 ms |               38.74 ms | 1.25x slower |
| refresh + exact, 90% hits |     51.95 ms |               66.36 ms | 1.28x slower |

The exact rows include input/output copies and `Set.has` verification for every Bloom candidate. The
exact `Set`, filter storage, and Workers are already resident; Worker startup and `Set` construction
are excluded. Candidate outputs exactly matched the serial filter and had no false negatives.

The existing blocked Bloom query remains useful when misses dominate: in the same run, the merged
filter plus exact verification was 5.19x faster than direct `Set` lookup at 90% misses and 2.15x at
50% misses. That benefit comes from the Bloom filter, not from concurrent construction.

The concurrent wrapper is not adopted. It accelerates a roughly 3 ms rebuild, but exact verification
dominates the representative operation, the median advantage disappears outside the most miss-heavy
case, and tail latency is noisy. `ShardedBitmap` already exposes the independently useful
Worker-local ownership and SIMD reduction ABI, so a separate concurrent Bloom collection would add
API and bundle cost without a robust end-to-end win.

Raw samples are in [`benchmarks/worker-local-build.json`](./benchmarks/worker-local-build.json).

```sh
just test-parallel-bloom-filter
just bench-parallel-bloom-filter
just bench-record-parallel-bloom-filter
```
