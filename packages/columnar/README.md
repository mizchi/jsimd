# `@mizchi/jsimd-columnar`

This experimental package extends `@mizchi/jsimd/columnar` from a resident data structure into a
small asynchronous page engine. A typed schema controls physical column types, immutable row groups
are stored behind one `PageBackend` contract, ZoneMaps prune row groups before I/O, and an LRU-like
cache turns loaded pages into the existing Wasm-resident SIMD columns.

The package is versioned independently from `@mizchi/jsimd`. Its persistent page format, writer
coordination, and cache policy are still experimental and may change between `0.x` releases.

## Browser / IndexedDB

```ts
import {
  defineSchema,
  defineTable,
  i32,
  IndexedDbPageBackend,
  nullable,
  SchemaEngine,
  string,
  u32,
  u8,
} from "@mizchi/jsimd-columnar";

const analytics = defineSchema({
  events: defineTable({
    id: u32(),
    temperature: i32({ nullable: true }),
    source: string({ nullable: true }),
    kind: u8({ bitWidth: 3 }),
  }),
});

const backend = await IndexedDbPageBackend.open("analytics");
using database = new SchemaEngine(analytics, backend);

await database.replace("events", {
  id: Uint32Array.of(10, 11, 12, 13),
  temperature: nullable(
    Int32Array.of(18, 0, 24, 31),
    Uint8Array.of(1, 0, 1, 1),
  ),
  source: ["sensor-a", null, "sensor-a", "sensor-b"],
  kind: Uint8Array.of(1, 2, 2, 3),
});

await database.updateRowGroups("events", [{
  index: 0,
  columns: {
    kind: Uint8Array.of(3, 3, 2, 1),
  },
}]);

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
import {
  defineSchema,
  defineTable,
  NodeFsPageBackend,
  SchemaEngine,
  u32,
} from "@mizchi/jsimd-columnar/node";

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
- Nullable numeric columns retain typed values plus a one-byte-per-row validity input/output.
  Comparisons exclude nulls; `whereNull()` and `whereNotNull()` query validity directly.
- String pages use a sorted per-row-group UTF-8 dictionary and resident `u32` codes. Equality and
  range predicates scan codes, while projection decodes only selected rows. Low-cardinality repeated
  strings are the intended case; high-cardinality or one-shot string scans can be slower and larger
  than direct JavaScript arrays.
- Schema evolution is deliberately additive: stored columns and `rowGroupSize` cannot change. A new
  nullable column is read as null, and a new non-nullable column requires a `default`. Defaults are
  virtual pages and cause no storage read.
- `replace()` writes a new immutable generation and publishes its manifest last. Old generations
  remain readable until explicit `vacuum()`.
- `updateRowGroups()` replaces only the named columns in fixed-size row groups. Unchanged column
  pages keep their immutable keys, so a one-column update does not rewrite or reconstruct the rest
  of the table. Every supplied column must contain exactly that row group's logical length.
- An engine holds a manifest snapshot. Another writer is observed only after `refresh(table)`, which
  also drops resident pages for that table.
- Engines sharing the same `PageBackend` object pin their observed manifest generations. `vacuum()`
  retains pages needed by those engines until they refresh or leave their `using` scope. Separate
  backend objects, browser tabs, and processes still require external writer/vacuum coordination.
- `cacheBytes` bounds retained host payload plus live Wasm encoded payload. `cacheStats()` exposes
  both components. A pinned query working set may temporarily exceed the bound, but lease release
  evicts back below it. This is live-payload accounting, not process RSS: JavaScript object headers
  and the non-shrinking Wasm linear-memory high-water mark are outside the budget.

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

Recorded with Deno 2.6.4 / V8 14.2 / Apple M5 over 4,194,304 rows in 64 row groups. One range
predicate selects a single group and a `u8` equality is composed into the resident mask. The fixed
runner uses five warmups, ten operations per sample, and retains all 15 raw samples in the shared
benchmark-result schema.

| workload                         | schema engine |     best relevant JS | result       |
| :------------------------------- | ------------: | -------------------: | :----------- |
| warm selective count             |     0.0524 ms | 0.0842 ms page-aware | 1.61x faster |
| warm two-column projection       |     0.1114 ms | 0.1640 ms page-aware | 1.47x faster |
| cold snapshot Memory restore     |      0.469 ms | 0.0842 ms page-aware | 5.57x slower |
| cold snapshot FS restore         |      0.607 ms | 0.0842 ms page-aware | 7.21x slower |
| cold snapshot Memory versus raw  |      0.469 ms |         3.295 ms raw | 7.02x faster |
| cold snapshot Memory versus scan |      0.469 ms |   5.552 ms full scan | 11.8x faster |

The useful contract is therefore repeated selective queries over a stable working set, or cold
queries whose ZoneMap/projection pruning avoids substantially more storage I/O. Direct snapshots
made the in-memory cold path 7.02x faster than raw reconstruction, but an equivalent page-aware JS
working set is still faster because it performs no restore. Small tables, one-shot queries, frequent
replacements, point reads, dense selections, and full result materialization are not target
workloads. Projection wins here because the mask is sparse: the Wasm gather enumerates set bits with
`ctz`; it does not claim an atomic or general SIMD gather instruction.

The benchmark intentionally compares against page-aware JavaScript, not only a naive full scan. The
manifest cache was necessary: reparsing it on every warm query made the first prototype 1.87x slower
than page-aware JavaScript.

### Real-browser IndexedDB restoration

Headless Chrome 152 on the same machine measured the selective count over 4,194,304 persisted rows.
The predicate reads two pages (104,516 bytes) from one of 64 row groups.

| measured boundary                       | median per query | p95 per query |
| :-------------------------------------- | ---------------: | ------------: |
| resident host/Wasm pages                |         0.010 ms |      0.050 ms |
| cleared page cache, open IndexedDB      |         0.290 ms |      0.360 ms |
| reopen IndexedDB and engine every query |         0.510 ms |      0.870 ms |

This measures engine/page restoration in a real browser, not guaranteed physical-disk cold I/O:
Chrome and the OS may retain database file pages. Each of the 30 recorded samples contains ten
operations to avoid rounding sub-millisecond measurements to zero. The versioned result includes all
raw samples, warmups, input shape, CPU/browser metadata, and correctness checks in
[`benchmarks/indexeddb-browser.json`](./benchmarks/indexeddb-browser.json).

## Isolated build size

The isolated tree-shake fixture imports the complete experimental schema engine and all column
types. Its production output contains a 14.56 kB gzip minified JavaScript asset and one 1.16 kB gzip
Wasm asset. The separate browser benchmark also imports the internal result harness, so it is not
used as the engine build-size measurement. These figures are updated by the repository verification
pass rather than estimated from source.

```sh
pnpm --filter @mizchi/jsimd-columnar test
just bench-columnar-schema-engine
just bench-record-columnar-schema-engine
pnpm bench:columnar-schema-indexeddb-browser
pnpm bench:record:columnar-schema-indexeddb-browser
```

## Missing before a public API

- Streaming result batches, limits, aggregates, ordering, and a predicate AST beyond AND
- Single-writer coordination, crash/fault injection, orphan cleanup policy, and concurrent vacuum
- OPFS comparison and an I/O benchmark large enough to exceed the OS/browser cache
