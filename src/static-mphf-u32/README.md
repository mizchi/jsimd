# StaticMphfU32

A frozen minimal perfect hash function (MPHF) for a known set of unique unsigned 32-bit keys. Every
construction key maps without collision to one implementation-defined ID in `[0, length)`.

```ts
import { StaticMphfU32, StaticMphfU32Builder } from "@mizchi/jsimd/static-mphf-u32";

const builder = new StaticMphfU32Builder();
builder.add(10).add(20).add(30).add(40);
using keywords = builder.freeze();

const id = keywords.lookup(30); // an ID in [0, 4)
keywords.has(999); // usually false; see membership semantics below

const queries = new Uint32Array([10, 999, 40]);
const ids = new Int32Array(queries.length);
keywords.lookupMany(queries, ids); // 2; miss slots contain -1
```

Use `lookupMany` for hot paths. It copies a query batch into Wasm once, hashes four first-level
queries per `v128`, completes routing, verifies fingerprints, and copies dense IDs out once. Bind
the frozen function with `using` so its resident allocation returns to the reuse pool.

IDs are stable only for one built snapshot. They do not preserve input order and may change when the
key set or implementation changes. To build a static dictionary, arrange the associated values by
calling `lookup` once per known key during construction, then use `lookupMany` at runtime.

`serialize()` preserves the displacement and fingerprint tables, including the dense-ID mapping.
`StaticMphfU32.fromSnapshot(bytes)` therefore restores the same IDs without repeating displacement
search. At 16,384 keys, a 49,184-byte snapshot restored about 2,074x faster than construction. The
16-bit false-positive contract remains unchanged after restore.

## Membership semantics

An MPHF defines collision-free results only for its construction set. An arbitrary unknown key also
routes to some candidate slot. This implementation stores a 16-bit fingerprint per slot and returns
`-1` when it differs.

For a populated bucket, an unknown key therefore has approximately a `1 / 2^16` chance of being
reported as present. Empty first-level buckets reject unknown keys exactly. Do not use `has` as an
authorization or correctness boundary. Store and compare the original key when exact membership is
required.

Duplicate construction keys throw. The complete `Uint32` domain, including `0xffffffff`, is
supported.

An existing mutable flat hash set can be frozen explicitly:

```ts
import { FlatHashSetU32 } from "@mizchi/jsimd/flat-hash";
import { StaticMphfU32 } from "@mizchi/jsimd/static-mphf-u32";

using mutable = FlatHashSetU32.from([10, 20, 30, 40]);
using frozen = StaticMphfU32.fromFlatHashSet(mutable);
```

The bridge enumerates and copies all keys, then runs the complete hash-and-displace construction. It
does not transfer ownership or reuse the mutable table layout; later changes to `mutable` do not
affect `frozen`. At 4,096 keys the recorded bridge was about 12.1 ms. Construction-order variance
dominated the direct-array comparison, so this API is a lifecycle convenience rather than a faster
MPHF builder.

## Layout and construction

The first hash divides keys into buckets averaging four keys. Construction orders non-singleton
buckets from largest to smallest and searches for a displacement whose second hash places every
bucket key in a free slot. Singleton buckets directly encode one of the remaining slots. The frozen
layout stores:

- one 32-bit displacement per four-key bucket;
- one 16-bit membership fingerprint per dense output slot;
- no original keys, tombstones, spare capacity, or mutable load-factor metadata.

At 262,144 keys this is exactly 3 logical bytes/key, compared with 10 logical bytes/key for the
benchmark's `FlatHashSetU32` capacity. The power-of-two reuse allocator may reserve more physical
memory than `encodedBytes` reports.

The construction is an uncompressed hash-and-displace variant of
[“Hash, displace, and compress”](https://cmph.sourceforge.net/papers/esa09.pdf). The batch-query
emphasis follows the streaming/throughput motivation of
[PtrHash](https://drops.dagstuhl.de/entities/document/10.4230/LIPIcs.SEA.2025.21), but this small
Wasm implementation is not PtrHash and does not match its space bound or construction algorithm.

## Performance characteristics

Recorded with Vitest 4.1.11 / Node 24 / Apple M5. The lookup set contains 262,144 keys and each
sample mixes 2,048 hits with 2,048 misses. Construction is measured separately over 16,384 keys.

| workload                |     MPHF | FlatHash | `Set<number>` |
| :---------------------- | -------: | -------: | ------------: |
| batch lookup, 4,096     |  37.9 us |  47.6 us |       66.4 us |
| individual calls, 4,096 | 531.6 us | 120.9 us |       66.4 us |
| build, 16,384 keys      |  55.6 ms |  1.33 ms |       1.58 ms |

MPHF `lookupMany` was 1.25x faster than FlatHash batching and 1.75x faster than a JavaScript
`Set.has` loop while using 70% fewer logical resident bytes than FlatHash. This is the intended
freeze-once, batch-query workload.

It is not a general `Set` replacement. Repeated single `lookup` calls were about 8x slower than the
native set because every call crosses the JS/Wasm boundary. MPHF construction was about 42x slower
than FlatHash construction because displacement search intentionally trades build time for a dense
output range and compact frozen storage.

```sh
pnpm bench:static-mphf-u32
pnpm bench:record:static-mphf-u32
pnpm bench:compare:static-mphf-u32
```

## Standalone build size

The isolated Vite fixture emits one 0.68 kB Wasm asset (0.39 kB gzip) and a 10.79 kB minified JS
wrapper (4.09 kB gzip). It does not emit FlatHash or any other entrypoint's Wasm.

Vitest baseline JSON and benchmark sources live in
[`experiments/static-mphf-u32`](../../experiments/static-mphf-u32). Cross-structure snapshot results
are in [`experiments/snapshots`](../../experiments/snapshots/README.md).

Files:

- `mod.ts`: builder, hash-and-displace construction, public contract, and allocator ownership
- `kernels.wat`: scalar lookup and four-query SIMD first-hash batching
- `kernels.d.wasm.ts`: typed Wasm module contract
- `kernels.wasm`: generated by `wasm-tools strip`, validated, and Git-ignored
