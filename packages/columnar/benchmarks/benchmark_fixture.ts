import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defineSchema,
  defineTable,
  i32,
  MemoryPageBackend,
  SchemaEngine,
  u32,
  u8,
} from "../src/mod.ts";
import { NodeFsPageBackend } from "../src/node.ts";

export const COLUMNAR_BENCHMARK_LENGTH = 4_194_304;
export const COLUMNAR_BENCHMARK_ROW_GROUP_SIZE = 65_536;
export const COLUMNAR_BENCHMARK_GROUP_COUNT = COLUMNAR_BENCHMARK_LENGTH /
  COLUMNAR_BENCHMARK_ROW_GROUP_SIZE;

const TARGET_GROUP = 31;
const MINIMUM = TARGET_GROUP * 100_000 + 12_000;
const MAXIMUM = MINIMUM + 5_000;
const CATEGORY = 3;

const schema = defineSchema({
  events: defineTable({
    id: u32(),
    temperature: i32(),
    kind: u8({ bitWidth: 3 }),
  }, { rowGroupSize: COLUMNAR_BENCHMARK_ROW_GROUP_SIZE }),
});

export interface ColumnarSchemaBenchmarkFixture extends AsyncDisposable {
  readonly inputBytes: number;
  readonly expectedCount: number;
  warmResidentCount(): Promise<number>;
  coldSnapshotMemoryCount(): Promise<number>;
  coldRawMemoryCount(): Promise<number>;
  coldSnapshotFsCount(): Promise<number>;
  pageAwareJsCount(): number;
  fusedJsCount(): number;
  warmProjection(): Promise<number>;
  pageAwareJsProject(): number;
}

export async function createColumnarSchemaBenchmarkFixture(): Promise<
  ColumnarSchemaBenchmarkFixture
> {
  const values = {
    id: Uint32Array.from({ length: COLUMNAR_BENCHMARK_LENGTH }, (_, index) => index),
    temperature: Int32Array.from({ length: COLUMNAR_BENCHMARK_LENGTH }, (_, index) => {
      const group = Math.floor(index / COLUMNAR_BENCHMARK_ROW_GROUP_SIZE);
      return group * 100_000 + index % COLUMNAR_BENCHMARK_ROW_GROUP_SIZE;
    }),
    kind: Uint8Array.from({ length: COLUMNAR_BENCHMARK_LENGTH }, (_, index) => index & 7),
  };
  const groupMinimum = Int32Array.from(
    { length: COLUMNAR_BENCHMARK_GROUP_COUNT },
    (_, group) => group * 100_000,
  );
  const groupMaximum = Int32Array.from(
    { length: COLUMNAR_BENCHMARK_GROUP_COUNT },
    (_, group) => group * 100_000 + COLUMNAR_BENCHMARK_ROW_GROUP_SIZE - 1,
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

  const pageAwareCount = () => {
    let count = 0;
    for (let group = 0; group < COLUMNAR_BENCHMARK_GROUP_COUNT; group++) {
      if (groupMaximum[group]! < MINIMUM || groupMinimum[group]! >= MAXIMUM) continue;
      const start = group * COLUMNAR_BENCHMARK_ROW_GROUP_SIZE;
      const end = start + COLUMNAR_BENCHMARK_ROW_GROUP_SIZE;
      for (let index = start; index < end; index++) {
        const value = values.temperature[index]!;
        if (value >= MINIMUM && value < MAXIMUM && values.kind[index] === CATEGORY) count++;
      }
    }
    return count;
  };
  const expectedCount = pageAwareCount();

  return {
    inputBytes: values.id.byteLength + values.temperature.byteLength + values.kind.byteLength,
    expectedCount,
    async warmResidentCount() {
      return (await selectiveCount(memoryEngine)).value;
    },
    async coldSnapshotMemoryCount() {
      memoryEngine.clearCache();
      return (await selectiveCount(memoryEngine)).value;
    },
    async coldRawMemoryCount() {
      rawMemoryEngine.clearCache();
      return (await selectiveCount(rawMemoryEngine)).value;
    },
    async coldSnapshotFsCount() {
      fsEngine.clearCache();
      return (await selectiveCount(fsEngine)).value;
    },
    pageAwareJsCount: pageAwareCount,
    fusedJsCount() {
      let count = 0;
      for (let index = 0; index < COLUMNAR_BENCHMARK_LENGTH; index++) {
        const value = values.temperature[index]!;
        if (value >= MINIMUM && value < MAXIMUM && values.kind[index] === CATEGORY) count++;
      }
      return count;
    },
    async warmProjection() {
      const result = await memoryEngine.query("events")
        .where("temperature", "between", MINIMUM, MAXIMUM)
        .where("kind", "eq", CATEGORY)
        .select("id", "temperature")
        .execute();
      return result.rowIds.length;
    },
    pageAwareJsProject() {
      const ids: number[] = [];
      const temperatures: number[] = [];
      const start = TARGET_GROUP * COLUMNAR_BENCHMARK_ROW_GROUP_SIZE;
      const end = start + COLUMNAR_BENCHMARK_ROW_GROUP_SIZE;
      for (let index = start; index < end; index++) {
        const value = values.temperature[index]!;
        if (value < MINIMUM || value >= MAXIMUM || values.kind[index] !== CATEGORY) continue;
        ids.push(values.id[index]!);
        temperatures.push(value);
      }
      if (ids.length !== temperatures.length) throw new Error("projection lengths differ");
      return ids.length;
    },
    async [Symbol.asyncDispose]() {
      fsEngine[Symbol.dispose]();
      rawMemoryEngine[Symbol.dispose]();
      memoryEngine[Symbol.dispose]();
      await rm(temporaryDirectory, { recursive: true, force: true });
    },
  };
}

function selectiveCount(engine: SchemaEngine<typeof schema>) {
  return engine.query("events")
    .where("temperature", "between", MINIMUM, MAXIMUM)
    .where("kind", "eq", CATEGORY)
    .count();
}
