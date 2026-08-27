import {
  defineSchema,
  defineTable,
  i32,
  IndexedDbPageBackend,
  MemoryPageBackend,
  nullable,
  SchemaEngine,
  string,
  u32,
  u8,
} from "./mod.ts";
import { NodeFsPageBackend } from "./node.ts";
import { SelectionMask } from "@mizchi/jsimd/columnar";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${message}: expected ${right}, got ${left}`);
}

const analytics = defineSchema({
  events: defineTable({
    id: u32(),
    temperature: i32(),
    kind: u8({ bitWidth: 3 }),
  }, { rowGroupSize: 256 }),
});

function fixture(length = 768) {
  return {
    id: Uint32Array.from({ length }, (_, index) => index + 10),
    temperature: Int32Array.from({ length }, (_, index) => {
      const group = index >>> 8;
      return group * 1_000 + (index & 255);
    }),
    kind: Uint8Array.from({ length }, (_, index) => index & 7),
  };
}

Deno.test("schema query prunes row groups, projects columns, and reuses resident pages", async () => {
  const backend = new MemoryPageBackend();
  using engine = new SchemaEngine(analytics, backend, { cacheBytes: 1 << 20 });
  await engine.replace("events", fixture());

  const first = await engine.query("events")
    .where("temperature", "between", 1_040, 1_090)
    .where("kind", "eq", 3)
    .select("id", "temperature")
    .execute();

  const expectedRows: number[] = [];
  for (let index = 296; index < 346; index++) {
    if ((index & 7) === 3) expectedRows.push(index);
  }
  assertEquals(Array.from(first.rowIds), expectedRows, "absolute row ids");
  assertEquals(
    Array.from(first.columns.id),
    expectedRows.map((index) => index + 10),
    "projected ids",
  );
  assertEquals(
    Array.from(first.columns.temperature),
    expectedRows.map((index) => 1_000 + (index & 255)),
    "projected temperatures",
  );
  assertEquals(first.stats.rowGroupsSkipped, 2, "zone-map row groups");
  assertEquals(first.stats.pagesRead, 3, "predicate and projection pages");

  const second = await engine.query("events")
    .where("temperature", "between", 1_040, 1_090)
    .where("kind", "eq", 3)
    .select("id")
    .execute();
  assertEquals(second.stats.pagesRead, 0, "warm page reads");
  assertEquals(second.stats.cacheHits, 3, "warm cache hits");

  const kindOne = engine.query("events").where("kind", "eq", 1);
  const low = await kindOne.where("temperature", "lt", 256).count();
  const high = await kindOne.where("temperature", "between", 2_000, 2_256).count();
  assertEquals(low.value, 32, "first query branch");
  assertEquals(high.value, 32, "second query branch");
});

Deno.test("count loads only predicate columns and replace publishes a new generation", async () => {
  const backend = new MemoryPageBackend();
  using engine = new SchemaEngine(analytics, backend, { cacheBytes: 1 << 20 });
  await engine.replace("events", fixture(512));
  engine.clearCache();

  const count = await engine.query("events").where("kind", "lt", 2).count();
  assertEquals(count.value, 128, "filtered count");
  assertEquals(count.stats.pagesRead, 2, "count predicate pages only");

  using observer = new SchemaEngine(analytics, backend);
  assertEquals((await observer.query("events").count()).value, 512, "observer initial snapshot");

  await engine.replace("events", {
    id: Uint32Array.of(99, 100),
    temperature: Int32Array.of(-2, 4),
    kind: Uint8Array.of(1, 2),
  });
  assertEquals((await observer.query("events").count()).value, 512, "observer remains on snapshot");
  await observer.refresh("events");
  assertEquals((await observer.query("events").count()).value, 2, "observer refreshes manifest");
  const replaced = await engine.query("events").select("id", "kind").execute();
  assertEquals(Array.from(replaced.columns.id), [99, 100], "replacement ids");
  assertEquals(Array.from(replaced.columns.kind), [1, 2], "replacement kinds");
  assert(
    (await backend.list("tables/events/pages/")).length > 3,
    "old pages retained before vacuum",
  );
  const removed = await engine.vacuum("events");
  assert(removed > 0, "vacuum removes old generation");
  assertEquals((await backend.list("tables/events/pages/")).length, 3, "current pages retained");
});

Deno.test("adaptive snapshots reduce persisted clustered-page bytes versus raw pages", async () => {
  const snapshotBackend = new MemoryPageBackend();
  const rawBackend = new MemoryPageBackend();
  {
    using snapshot = new SchemaEngine(analytics, snapshotBackend);
    using raw = new SchemaEngine(analytics, rawBackend, { pageFormat: "raw" });
    const data = fixture(768);
    await snapshot.replace("events", data);
    await raw.replace("events", data);
  }
  const snapshotBytes = await pageBytes(snapshotBackend, "tables/events/pages/");
  const rawBytes = await pageBytes(rawBackend, "tables/events/pages/");
  assert(snapshotBytes < rawBytes, `snapshot bytes ${snapshotBytes} < raw bytes ${rawBytes}`);
});

Deno.test("schema and page validation reject incompatible or corrupt storage", async () => {
  const backend = new MemoryPageBackend();
  {
    using engine = new SchemaEngine(analytics, backend);
    await engine.replace("events", fixture(8));
  }

  const incompatible = defineSchema({
    events: defineTable({ id: u32(), temperature: u32(), kind: u8({ bitWidth: 3 }) }),
  });
  using wrong = new SchemaEngine(incompatible, backend);
  await assertRejects(() => wrong.query("events").select("id").execute(), "schema mismatch");

  const manifestBytes = await backend.get("tables/events/manifest.json");
  assert(manifestBytes !== undefined, "manifest exists");
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  const pageKey = manifest.rowGroups[0].columns.id.key as string;
  const page = await backend.get(pageKey);
  assert(page !== undefined, "page exists");
  page[0] ^= 0xff;
  await backend.put(pageKey, page);
  using corrupt = new SchemaEngine(analytics, backend);
  await assertRejects(() => corrupt.query("events").select("id").execute(), "invalid page magic");
});

Deno.test("Node FS backend survives engine reopen", async () => {
  const directory = await Deno.makeTempDir({ prefix: "jsimd-columnar-" });
  try {
    {
      using engine = new SchemaEngine(analytics, new NodeFsPageBackend(directory));
      await engine.replace("events", fixture(300));
    }
    {
      using engine = new SchemaEngine(analytics, new NodeFsPageBackend(directory));
      const result = await engine.query("events")
        .where("id", "between", 100, 110)
        .select("id")
        .execute();
      assertEquals(Array.from(result.columns.id), [
        100,
        101,
        102,
        103,
        104,
        105,
        106,
        107,
        108,
        109,
      ], "FS persisted query");
      assertEquals(result.stats.rowGroupsSkipped, 1, "FS zone-map pruning");
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test({
  name: "IndexedDB backend survives engine reopen",
  ignore: !("indexedDB" in globalThis),
  async fn() {
    const name = `jsimd-columnar-${crypto.randomUUID()}`;
    try {
      {
        const backend = await IndexedDbPageBackend.open(name);
        using engine = new SchemaEngine(analytics, backend);
        await engine.replace("events", fixture(300));
      }
      {
        const backend = await IndexedDbPageBackend.open(name);
        using engine = new SchemaEngine(analytics, backend);
        const result = await engine.query("events").where("kind", "eq", 7).select("id").execute();
        assertEquals(result.rowIds.length, 37, "IndexedDB persisted result");
      }
    } finally {
      await IndexedDbPageBackend.deleteDatabase(name);
    }
  },
});

Deno.test("concurrent cold queries share page restoration and release the Wasm cache", async () => {
  const before = SelectionMask.allocatorStats();
  {
    const backend = new MemoryPageBackend();
    using engine = new SchemaEngine(analytics, backend, { cacheBytes: 1 << 20 });
    await engine.replace("events", fixture(768));
    engine.clearCache();
    const results = await Promise.all(
      Array.from(
        { length: 8 },
        () => engine.query("events").where("temperature", "between", 1_000, 2_000).count(),
      ),
    );
    assert(results.every((result) => result.value === 256), "concurrent query results");
  }
  const after = SelectionMask.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "concurrent live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "concurrent live bytes");
});

Deno.test("nullable numeric and dictionary string columns preserve validity", async () => {
  const schema = defineSchema({
    events: defineTable({
      id: u32(),
      score: i32({ nullable: true }),
      tag: string({ nullable: true }),
    }, { rowGroupSize: 256 }),
  });
  using engine = new SchemaEngine(schema, new MemoryPageBackend());
  await engine.replace("events", {
    id: Uint32Array.of(10, 11, 12, 13, 14),
    score: nullable(Int32Array.of(5, 99, 7, 50, 9), Uint8Array.of(1, 0, 1, 1, 1)),
    tag: ["cold", "hot", null, "hot", "cold"],
  });

  const numeric = await engine.query("events")
    .where("score", "lt", 10)
    .select("id", "score", "tag")
    .execute();
  assertEquals(Array.from(numeric.rowIds), [0, 2, 4], "null numeric values do not match");
  assertEquals(Array.from(numeric.columns.id), [10, 12, 14], "numeric projection ids");
  assertEquals(Array.from(numeric.columns.score.values), [5, 7, 9], "nullable values");
  assertEquals(Array.from(numeric.columns.score.validity), [1, 1, 1], "nullable validity");
  assertEquals(numeric.columns.tag, ["cold", null, "cold"], "nullable strings");

  const strings = await engine.query("events")
    .where("tag", "eq", "hot")
    .select("id", "tag")
    .execute();
  assertEquals(Array.from(strings.columns.id), [11, 13], "dictionary equality ids");
  assertEquals(strings.columns.tag, ["hot", "hot"], "dictionary projection");

  const missing = await engine.query("events").whereNull("tag").select("id").execute();
  assertEquals(Array.from(missing.columns.id), [12], "null predicate");
  const present = await engine.query("events").whereNotNull("score").count();
  assertEquals(present.value, 4, "not-null predicate");
  const cache = engine.cacheStats();
  assert(cache.hostBytes > 0, "dictionary payload remains host-resident");
  assert(cache.wasmBytes > 0, "dictionary codes and numeric pages become Wasm-resident");
});

Deno.test("additive schema evolution materializes defaults without stored pages", async () => {
  const backend = new MemoryPageBackend();
  const initial = defineSchema({
    events: defineTable({ id: u32() }, { rowGroupSize: 256 }),
  });
  {
    using engine = new SchemaEngine(initial, backend);
    await engine.replace("events", { id: Uint32Array.of(20, 21, 22) });
  }

  const evolved = defineSchema({
    events: defineTable({
      id: u32(),
      score: i32({ default: 7 }),
      note: string({ nullable: true }),
    }, { rowGroupSize: 256 }),
  });
  using engine = new SchemaEngine(evolved, backend);
  const result = await engine.query("events")
    .where("score", "eq", 7)
    .select("id", "score", "note")
    .execute();
  assertEquals(Array.from(result.columns.id), [20, 21, 22], "stored column");
  assertEquals(Array.from(result.columns.score), [7, 7, 7], "numeric default");
  assertEquals(result.columns.note, [null, null, null], "nullable default");
  assertEquals(result.stats.pagesRead, 1, "defaults do not read physical pages");

  const incompatible = defineSchema({
    events: defineTable({ id: i32() }, { rowGroupSize: 256 }),
  });
  using wrong = new SchemaEngine(incompatible, backend);
  await assertRejects(() => wrong.query("events").count(), "changed column kind is rejected");
});

Deno.test("cache budget accounts for retained host and Wasm bytes", async () => {
  const backend = new MemoryPageBackend();
  using engine = new SchemaEngine(analytics, backend, {
    cacheBytes: 1_200,
    pageFormat: "raw",
  });
  await engine.replace("events", fixture(768));
  engine.clearCache();
  await engine.query("events").where("temperature", "lt", 10_000).select("id").execute();
  const stats = engine.cacheStats();
  assert(stats.totalBytes <= stats.maximumBytes, "released cache remains within its hard budget");
  assertEquals(stats.totalBytes, stats.hostBytes + stats.wasmBytes, "combined accounting");
  assert(stats.evictions > 0, "the combined budget evicts pages");
});

Deno.test("nullable and dictionary cache disposal releases all Wasm allocations", async () => {
  const before = SelectionMask.allocatorStats();
  {
    const schema = defineSchema({
      values: defineTable({
        number: i32({ nullable: true }),
        category: string({ nullable: true }),
      }, { rowGroupSize: 256 }),
    });
    using engine = new SchemaEngine(schema, new MemoryPageBackend());
    await engine.replace("values", {
      number: nullable(Int32Array.of(1, 2, 3), Uint8Array.of(1, 0, 1)),
      category: ["a", null, "b"],
    });
    await engine.query("values").whereNotNull("category").select("number").execute();
  }
  const after = SelectionMask.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "nullable live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "nullable live bytes");
});

async function assertRejects(operation: () => Promise<unknown>, message: string): Promise<void> {
  let rejected = false;
  try {
    await operation();
  } catch {
    rejected = true;
  }
  assert(rejected, message);
}

async function pageBytes(backend: MemoryPageBackend, prefix: string): Promise<number> {
  let total = 0;
  for (const key of await backend.list(prefix)) total += (await backend.get(key))!.byteLength;
  return total;
}
