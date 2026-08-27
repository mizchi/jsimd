import { afterAll, bench, describe } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, defineTable, i32, MemoryPageBackend, SchemaEngine, u32, u8 } from "./mod.ts";
import { NodeFsPageBackend } from "./node.ts";

const LENGTH = 4_194_304;
const ROW_GROUP_SIZE = 65_536;
const GROUP_COUNT = LENGTH / ROW_GROUP_SIZE;
const TARGET_GROUP = 31;
const MINIMUM = TARGET_GROUP * 100_000 + 12_000;
const MAXIMUM = MINIMUM + 5_000;
const CATEGORY = 3;

const schema = defineSchema({
  events: defineTable({
    id: u32(),
    temperature: i32(),
    kind: u8({ bitWidth: 3 }),
  }, { rowGroupSize: ROW_GROUP_SIZE }),
});

const values = {
  id: Uint32Array.from({ length: LENGTH }, (_, index) => index),
  temperature: Int32Array.from({ length: LENGTH }, (_, index) => {
    const group = Math.floor(index / ROW_GROUP_SIZE);
    return group * 100_000 + index % ROW_GROUP_SIZE;
  }),
  kind: Uint8Array.from({ length: LENGTH }, (_, index) => index & 7),
};

const groupMinimum = Int32Array.from({ length: GROUP_COUNT }, (_, group) => group * 100_000);
const groupMaximum = Int32Array.from(
  { length: GROUP_COUNT },
  (_, group) => group * 100_000 + ROW_GROUP_SIZE - 1,
);

const memoryBackend = new MemoryPageBackend();
const memoryEngine = new SchemaEngine(schema, memoryBackend, { cacheBytes: 64 * 1024 * 1024 });
await memoryEngine.replace("events", values);
await selectiveCount(memoryEngine);

const rawMemoryBackend = new MemoryPageBackend();
const rawMemoryEngine = new SchemaEngine(schema, rawMemoryBackend, {
  cacheBytes: 64 * 1024 * 1024,
  pageFormat: "raw",
});
await rawMemoryEngine.replace("events", values);

const temporaryDirectory = await mkdtemp(join(tmpdir(), "jsimd-columnar-bench-"));
const fsEngine = new SchemaEngine(schema, new NodeFsPageBackend(temporaryDirectory), {
  cacheBytes: 64 * 1024 * 1024,
});
await fsEngine.replace("events", values);

let sink = 0;

describe("columnar schema engine selective count over 4M rows", () => {
  bench("warm resident Wasm query", async () => {
    const result = await selectiveCount(memoryEngine);
    sink ^= result.value;
  });

  bench("cold snapshot Memory restore + Wasm query", async () => {
    memoryEngine.clearCache();
    const result = await selectiveCount(memoryEngine);
    sink ^= result.value;
  });

  bench("cold raw Memory rebuild + Wasm query", async () => {
    rawMemoryEngine.clearCache();
    const result = await selectiveCount(rawMemoryEngine);
    sink ^= result.value;
  });

  bench("cold snapshot FS restore + Wasm query", async () => {
    fsEngine.clearCache();
    const result = await selectiveCount(fsEngine);
    sink ^= result.value;
  });

  bench("page-aware typed-array JS query", () => {
    sink ^= pageAwareJsCount();
  });

  bench("fused full typed-array JS scan", () => {
    sink ^= fusedJsCount();
  });
});

describe("selective projection materialization", () => {
  bench("warm schema query + two-column projection", async () => {
    const result = await memoryEngine.query("events")
      .where("temperature", "between", MINIMUM, MAXIMUM)
      .where("kind", "eq", CATEGORY)
      .select("id", "temperature")
      .execute();
    sink ^= result.rowIds.length;
  });

  bench("page-aware JS + two-column projection", () => {
    sink ^= pageAwareJsProject();
  });
});

afterAll(async () => {
  fsEngine[Symbol.dispose]();
  rawMemoryEngine[Symbol.dispose]();
  memoryEngine[Symbol.dispose]();
  await rm(temporaryDirectory, { recursive: true, force: true });
  if (sink === -1) console.log(sink);
});

function selectiveCount(engine: SchemaEngine<typeof schema>) {
  return engine.query("events")
    .where("temperature", "between", MINIMUM, MAXIMUM)
    .where("kind", "eq", CATEGORY)
    .count();
}

function pageAwareJsCount(): number {
  let count = 0;
  for (let group = 0; group < GROUP_COUNT; group++) {
    if (groupMaximum[group]! < MINIMUM || groupMinimum[group]! >= MAXIMUM) continue;
    const start = group * ROW_GROUP_SIZE;
    const end = start + ROW_GROUP_SIZE;
    for (let index = start; index < end; index++) {
      const value = values.temperature[index]!;
      if (value >= MINIMUM && value < MAXIMUM && values.kind[index] === CATEGORY) count++;
    }
  }
  return count;
}

function fusedJsCount(): number {
  let count = 0;
  for (let index = 0; index < LENGTH; index++) {
    const value = values.temperature[index]!;
    if (value >= MINIMUM && value < MAXIMUM && values.kind[index] === CATEGORY) count++;
  }
  return count;
}

function pageAwareJsProject(): number {
  const ids: number[] = [];
  const temperatures: number[] = [];
  const group = TARGET_GROUP;
  const start = group * ROW_GROUP_SIZE;
  const end = start + ROW_GROUP_SIZE;
  for (let index = start; index < end; index++) {
    const value = values.temperature[index]!;
    if (value < MINIMUM || value >= MAXIMUM || values.kind[index] !== CATEGORY) continue;
    ids.push(values.id[index]!);
    temperatures.push(value);
  }
  return ids.length ^ temperatures.length;
}
