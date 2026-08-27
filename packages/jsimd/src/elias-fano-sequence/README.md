# EliasFanoSequence

An immutable Elias–Fano encoding for non-decreasing unsigned 32-bit sequences. It preserves
duplicates and supports point access and ordered queries without decoding the complete sequence.

```ts
import {
  EliasFanoSequence,
  EliasFanoSequenceBuilder,
  PartitionedEliasFanoSequence,
} from "@mizchi/jsimd/elias-fano-sequence";

const builder = new EliasFanoSequenceBuilder();
builder.append(1).append(1).append(3).append(10).append(100);
using offsets = builder.freeze();

offsets.at(2); // 3
offsets.rank(10); // 3: number of values strictly below 10
offsets.nextGEQ(4); // 10
offsets.predecessor(10); // 3: strict predecessor

const ranks = new Uint32Array(3);
offsets.rankMany(new Uint32Array([0, 3, 11]), ranks); // [0, 2, 4]

const decoded = new Uint32Array(offsets.length);
offsets.decodeInto(decoded);

using clustered = PartitionedEliasFanoSequence.from(values, 256);
clustered.rank(query);
clustered.encodingCounts(); // contiguous blocks vs local Elias-Fano blocks
```

When the physical representation is chosen later, use the shared host-side builder and name the
target explicitly:

```ts
import { EliasFanoSequence, MonotoneUint32Builder } from "@mizchi/jsimd/elias-fano-sequence";

const source = new MonotoneUint32Builder().append(1).append(1).append(3).append(10);
using values = EliasFanoSequence.fromMonotone(source);
```

`fromMonotone` copies all values before encoding; it does not consume or share the builder. The
builder permits duplicates because Elias–Fano does. The same builder can be passed to
`PackedDeltaUint32List.fromMonotone` only when it is strictly increasing. At 65,536 values the
recorded EF bridge took about 2.50 ms versus 2.58 ms from an existing `Uint32Array`; the difference
was within benchmark noise, while both include the complete encoding build.

`rank(value)` is the lower-bound index. `nextGEQ` returns the first stored value greater than or
equal to the query, while `predecessor` returns the largest strictly smaller value. Both return `-1`
when no result exists. Query bounds may use `2^32`, allowing `rank(2 ** 32)` to return the complete
length even when the sequence contains `0xffffffff`.

Inputs must already be non-decreasing. Descending input throws instead of sorting silently. The
builder produces independent frozen snapshots. Always bind each frozen sequence with `using` so its
high bits, lower bits, and rank-index allocations return to the free list at scope exit.

The persistence API is distinct from the builder's immutable “snapshot” terminology: `serialize()`
returns a versioned byte representation, and `EliasFanoSequence.fromSnapshot(bytes)` restores it.
The packed high/low bits are copied directly, while the small 512-bit rank prefix is rebuilt and
validated. For 65,536 values, the 39,140-byte snapshot restored about 51x faster than construction.

## Layout and algorithm

For `n` values in universe `[0, U)`, the encoding chooses `L = floor(log2(U / n))`, clamped to 0–32.
Each value is split into:

- a packed `L`-bit lower part;
- a unary upper bit at position `(value >> L) + index`.

The upper bitvector stores a cumulative one-count every 512 bits. `at` uses upper `select1` plus one
packed lower-bit extraction. `rank` locates the matching upper bucket with indexed `select0`, then
binary-searches only the lower bits inside that bucket. Batch access and rank keep all queries
inside one Wasm call. `decodeInto` scans the unary upper words once rather than executing a select
for every value.

`encodedBytes` reports logical packed lower bytes, upper words, and rank prefixes. The resident
allocator rounds its three blocks to power-of-two size classes, so allocator-reserved bytes can be
higher. Construction builds temporary JavaScript word arrays and is intended for freeze-once,
query-many workloads.

## Design source

The high-unary/low-packed representation and its use for monotone postings are described in
[“Techniques for Inverted Index Compression”](https://arxiv.org/html/1908.10598v2).
`PartitionedEliasFanoSequence` applies the representation locally. A strictly contiguous block
stores only base/length metadata; every other block subtracts its local base and builds an
independent Elias–Fano sequence. Each block costs 16 logical metadata bytes, so global EF remains
preferable without useful local structure.

## Benchmark

Recorded with Vitest 4.1.11 / Node 24 / Apple M5 over 262,144 strict-monotone values. Each point or
rank sample contains 1,024 queries. Construction is excluded.

| workload        | EF bytes/value | PackedDelta bytes/value | EF atMany | PackedDelta at | typed access | EF rankMany | PackedDelta rank | typed lowerBound | EF decode | PackedDelta decode | typed copy |
| :-------------- | -------------: | ----------------------: | --------: | -------------: | -----------: | ----------: | ---------------: | ---------------: | --------: | -----------------: | ---------: |
| small deltas    |          0.457 |                   1.313 |   15.7 us |        40.0 us |       3.0 us |     36.3 us |          74.0 us |          31.8 us |    468 us |             254 us |    13.0 us |
| variable deltas |          0.770 |                   1.313 |   16.4 us |        40.9 us |       3.1 us |     33.6 us |          74.1 us |          33.2 us |    485 us |             308 us |    13.0 us |

Elias–Fano is not a universal speed replacement for `Uint32Array`. Direct typed-array access is
about 5x faster, and native copying is about 36x faster than EF decode. Use the uncompressed array
when 4 bytes/value is acceptable and those operations dominate.

The useful trade-off is compressed random querying. These datasets used only 0.46–0.77 logical
bytes/value, 41–65% less than PackedDelta and 81–89% less than `Uint32Array`. EF point access was
about 2.5x faster than PackedDelta, and optimized EF rank was 2.0–2.2x faster than PackedDelta while
landing near typed-array binary search. PackedDelta remains preferable for faster sequential decode
and its SIMD postings intersection.

On 262,144 values arranged as 256-value contiguous clusters separated by one million, 1,024
partitioned ranks took 0.0158 ms. Global EF took 0.1777 ms and typed-array lower bounds took 0.0395
ms: partitioning was respectively 11.22x and 2.49x faster. Uniform values can lose through metadata.

```sh
pnpm bench:elias-fano-sequence
pnpm bench:record:elias-fano-sequence
pnpm bench:compare:elias-fano-sequence
```

## Standalone build size

The isolated Vite fixture using global and partitioned sequences emits one 1.64 kB Wasm asset (0.86
kB gzip) and a 14.89 kB minified JS wrapper (5.09 kB gzip). It does not emit PackedDelta or
RankSelectBitVector Wasm.

Vitest baseline JSON and benchmark sources live in
[`experiments/elias-fano-sequence`](../../experiments/elias-fano-sequence). Cross-structure snapshot
results are in [`experiments/snapshots`](../../experiments/snapshots/README.md).

Files:

- `mod.ts`: builder, encoding, public queries, and allocator ownership
- `kernels.wat`: SIMD rank-index build, upper select, lower extraction, batch queries, and decode
- `kernels.d.wasm.ts`: typed Wasm module contract
- `kernels.wasm`: generated, stripped, validated, and Git-ignored
