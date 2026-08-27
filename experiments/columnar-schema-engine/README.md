# Columnar schema engine experiment

This prototype extends `columnar` from a resident data structure into a small asynchronous page
engine. A typed schema controls physical column types, immutable row groups are stored behind one
`PageBackend` contract, ZoneMaps prune row groups before I/O, and an LRU-like cache turns loaded
pages into the existing Wasm-resident SIMD columns.

It is intentionally under `experiments/`. The measured warm workload wins, but the persistent page
format, writer coordination, IndexedDB browser tests, and cache policy are not stable enough for a
package export.

## Browser / IndexedDB

```ts
import {
  defineSchema,
  defineTable,
  i32,
  IndexedDbPageBackend,
  SchemaEngine,
  u32,
  u8,
} from "./mod.ts";

const analytics = defineSchema({
  events: defineTable({
    id: u32(),
    temperature: i32(),
    kind: u8({ bitWidth: 3 }),
  }),
});

const backend = await IndexedDbPageBackend.open("analytics");
using database = new SchemaEngine(analytics, backend);

await database.replace("events", {
  id: Uint32Array.of(10, 11, 12, 13),
  temperature: Int32Array.of(18, 21, 24, 31),
  kind: Uint8Array.of(1, 2, 2, 3),
});

const result = await database.query("events")
  .where("temperature", "between", 20, 30) // half-open [20, 30)
  .where("kind", "eq", 2)
  .select("id", "temperature")
  .execute();
```

`using` closes the IndexedDB connection and releases all cached Wasm allocations. `count()` avoids
projection reads and row-ID materialization:

```ts
const count = await database.query("events").where("kind", "lt", 3).count();
```

The browser-safe `mod.ts` does not import Node builtins. Vite compilation and type checking are
covered; the real IndexedDB runtime test remains skipped outside a browser. Current isolated bundle
sizes are recorded below after every production-fixture build.

## Node / filesystem

```ts
import { defineSchema, defineTable, NodeFsPageBackend, SchemaEngine, u32 } from "./node.ts";

const schema = defineSchema({ values: defineTable({ value: u32() }) });
using database = new SchemaEngine(schema, new NodeFsPageBackend("./data"));
```

The Node adapter is isolated in `node.ts`, uses `node:fs/promises`, and publishes each key through a
temporary file plus rename. It is tested on Deno through Node compatibility and targets Node 24.5+.

## Storage and query path

```text
typed arrays
  -> immutable generation / directly restorable adaptive snapshots
  -> manifest publish (last write)
  -> ZoneMap row-group pruning
  -> backend reads for predicate + projection columns only
  -> resident page cache
  -> AdaptiveI32Column / AdaptiveU32Column / BitSlicedU8Column
  -> shared SelectionMask
  -> count or sparse bulk gather into typed-array projections
```

- A storage row group defaults to 65,536 rows and must be a multiple of the SIMD column's 256-row
  internal page size.
- Each column page has a versioned little-endian envelope and checksum. Snapshot pages preserve the
  adaptive page metadata and encoded payload, so a cold load validates and copies the frozen
  representation without decoding and repacking it. `pageFormat: "raw"` remains available only for
  the reconstruction benchmark.
- The manifest stores per-column `min`/`max`, so any false predicate skips the whole row group
  before page reads. Projection columns are loaded only for row groups that survive.
- `replace()` writes a new immutable generation and publishes its manifest last. Old generations
  remain readable until explicit `vacuum()`.
- An engine holds a manifest snapshot. Another writer is observed only after `refresh(table)`, which
  also drops resident pages for that table.
- `cacheBytes` currently budgets serialized page bytes approximately, not total host plus rounded
  Wasm allocator capacity.

The backend contract is deliberately small:

```ts
interface PageBackend {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<readonly string[]>;
}
```

`MemoryPageBackend`, `IndexedDbPageBackend`, and `NodeFsPageBackend` all copy bytes at the contract
boundary. A future OPFS, object-store, HTTP-range, or custom database adapter can use the same
interface.

## Performance characteristics

Recorded with Vitest 4.1.11 / Node 24 / Apple M5 over 4,194,304 rows in 64 row groups. One range
predicate selects a single group and a `u8` equality is composed into the resident mask.

| workload                         | schema engine |     best relevant JS | result       |
| :------------------------------- | ------------: | -------------------: | :----------- |
| warm selective count             |     0.0185 ms | 0.0478 ms page-aware | 2.58x faster |
| warm two-column projection       |     0.0417 ms | 0.0668 ms page-aware | 1.60x faster |
| cold snapshot Memory restore     |      0.320 ms | 0.0478 ms page-aware | 6.69x slower |
| cold snapshot FS restore         |      0.577 ms | 0.0478 ms page-aware | 12.1x slower |
| cold snapshot Memory versus raw  |      0.320 ms |         2.862 ms raw | 8.94x faster |
| cold snapshot Memory versus scan |      0.320 ms |   3.759 ms full scan | 11.7x faster |

The useful contract is therefore repeated selective queries over a stable working set, or cold
queries whose ZoneMap/projection pruning avoids substantially more storage I/O. Direct snapshots
made the in-memory cold path 8.94x faster than raw reconstruction, but an equivalent page-aware JS
working set is still faster because it performs no restore. Small tables, one-shot queries, frequent
replacements, point reads, dense selections, and full result materialization are not target
workloads. Projection wins here because the mask is sparse: the Wasm gather enumerates set bits with
`ctz`; it does not claim an atomic or general SIMD gather instruction.

The benchmark intentionally compares against page-aware JavaScript, not only a naive full scan. The
manifest cache was necessary: reparsing it on every warm query made the first prototype 1.87x slower
than page-aware JavaScript.

## Isolated build size

The browser fixture imports the complete experimental schema engine and all three column types. Its
production output contains a 10.73 kB gzip minified JavaScript asset and one 1.16 kB gzip Wasm
asset. These figures are updated by the repository verification pass rather than estimated from
source.

```sh
pnpm test:columnar-schema-engine
pnpm bench:columnar-schema-engine --run
pnpm bench:record:columnar-schema-engine --run
```

## Missing before a public API

- Automated real-browser IndexedDB correctness and latency tests
- Nullability, strings, dictionaries, and schema evolution rules
- Streaming result batches, limits, aggregates, ordering, and a predicate AST beyond AND
- Bounded cache accounting across both host and Wasm memory
- Single-writer coordination, crash/fault injection, orphan cleanup policy, and concurrent vacuum
- OPFS comparison and an I/O benchmark large enough to exceed the OS/browser cache
