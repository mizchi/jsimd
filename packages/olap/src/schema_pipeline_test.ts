import {
  defineSchema,
  defineTable,
  i32,
  MemoryPageBackend,
  SchemaEngine,
} from "@mizchi/jsimd-columnar";
import { I32AggregatePipeline } from "./physical_pipeline.ts";
import { scanBetweenReference } from "./mod.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function fixture(): Int32Array {
  const values = new Int32Array(768);
  values.fill(-7, 0, 256);
  for (let index = 256; index < 512; index++) values[index] = 1_000 + (index & 255);
  for (let index = 512; index < 768; index++) {
    values[index] = 0x6000_0000 + (index & 1 ? 100_000 : 0) + index;
  }
  return values;
}

Deno.test("SchemaEngine snapshots execute in shared Wasm without resident column reconstruction", async () => {
  const schema = defineSchema({
    events: defineTable({ value: i32() }, { rowGroupSize: 256 }),
  });
  using engine = new SchemaEngine(schema, new MemoryPageBackend());
  const values = fixture();
  await engine.replace("events", { value: values });
  assert(engine.cacheStats().pages === 0, "replace does not create resident pages");

  await using pipeline = await I32AggregatePipeline.createFromSchema(
    engine,
    "events",
    "value",
    {
      workerCount: 2,
      costModel: {
        directPageOverheadMs: 1,
        workerPageOverheadMs: 0,
        rawRowCostMs: 0,
        constantRowCostMs: 0,
        frameOfReferenceRowCostMs: 0,
        workerDispatchMs: 0,
        parallelEfficiency: 1,
      },
    },
  );
  assert(engine.cacheStats().pages === 0, "pipeline bypasses the SchemaEngine resident cache");
  assert(
    pipeline.encodedPayloadBytes < values.byteLength,
    "shared storage keeps compressed payloads",
  );
  assert(pipeline.chunk.pages.length === 3, "physical metadata comes from encoded pages");
  assert(pipeline.persistedGeneration !== undefined, "persisted generation is retained");

  const expected = scanBetweenReference(values, 900, 1_100);
  const direct = await pipeline.aggregateBetween(900, 1_100, { execution: "direct" });
  const workers = await pipeline.aggregateBetween(900, 1_100, { execution: "workers" });
  assert(direct.count === expected.count && direct.sum === expected.sum, "direct compressed scan");
  assert(
    workers.count === expected.count && workers.sum === expected.sum,
    "Worker compressed scan",
  );
  assert(direct.pagesScanned === 1 && direct.pagesSkipped === 2, "encoded ZoneMap pruning");
});

Deno.test("schema-backed pipeline keeps its immutable generation after a table replacement", async () => {
  const schema = defineSchema({
    events: defineTable({ value: i32() }, { rowGroupSize: 256 }),
  });
  using engine = new SchemaEngine(schema, new MemoryPageBackend());
  const values = fixture();
  await engine.replace("events", { value: values });
  await using pipeline = await I32AggregatePipeline.createFromSchema(
    engine,
    "events",
    "value",
    { workerCount: 1 },
  );
  const generation = pipeline.persistedGeneration;

  await engine.replace("events", { value: new Int32Array(values.length).fill(42) });
  assert(pipeline.persistedGeneration === generation, "executor owns an immutable snapshot copy");
  const result = await pipeline.aggregateBetween(-7, -6, { execution: "direct" });
  assert(result.count === 256, "old generation remains queryable");
});
