import {
  defineSchema,
  defineTable,
  i32,
  IndexedDbPageBackend,
  SchemaEngine,
  u32,
  u8,
} from "../mod.ts";
import {
  measureConstructionInclusive,
  measureEndToEnd,
  measureResident,
} from "../../../tools/benchmark/measure.ts";
import {
  type BenchmarkResultV1,
  createBenchmarkResult,
  detectBenchmarkEnvironment,
} from "../../../tools/benchmark/result.ts";

const BENCHMARK_ROW_GROUP_SIZE = 65_536;

export async function benchmarkIndexedDbRestoration(
  rows = 4_194_304,
  iterations = 30,
  warmups = 5,
  cpu = "unavailable",
): Promise<BenchmarkResultV1> {
  if (!Number.isSafeInteger(rows) || rows < BENCHMARK_ROW_GROUP_SIZE) {
    throw new RangeError("rows must be at least one row group");
  }
  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new RangeError("iterations must be positive");
  }
  if (!Number.isSafeInteger(warmups) || warmups < 0) {
    throw new RangeError("warmups must be non-negative");
  }
  const databaseName = `jsimd-columnar-browser-${crypto.randomUUID()}`;
  const benchmarkSchema = defineSchema({
    events: defineTable({
      id: u32(),
      temperature: i32(),
      kind: u8({ bitWidth: 3 }),
    }, { rowGroupSize: BENCHMARK_ROW_GROUP_SIZE }),
  });
  const targetGroup = Math.floor(rows / BENCHMARK_ROW_GROUP_SIZE / 2);
  const minimum = targetGroup * 100_000 + 12_000;
  const maximum = minimum + 5_000;
  const category = 3;
  const values = {
    id: Uint32Array.from({ length: rows }, (_, index) => index),
    temperature: Int32Array.from({ length: rows }, (_, index) => {
      const group = Math.floor(index / BENCHMARK_ROW_GROUP_SIZE);
      return group * 100_000 + index % BENCHMARK_ROW_GROUP_SIZE;
    }),
    kind: Uint8Array.from({ length: rows }, (_, index) => index & 7),
  };
  const query = (engine: SchemaEngine<typeof benchmarkSchema>) =>
    engine.query("events")
      .where("temperature", "between", minimum, maximum)
      .where("kind", "eq", category)
      .count();

  try {
    {
      const backend = await IndexedDbPageBackend.open(databaseName);
      using engine = new SchemaEngine(benchmarkSchema, backend);
      await engine.replace("events", values);
    }
    // The persisted copy is the benchmark input; do not retain the construction arrays.
    values.id.fill(0);
    values.temperature.fill(0);
    values.kind.fill(0);

    const backend = await IndexedDbPageBackend.open(databaseName);
    using engine = new SchemaEngine(benchmarkSchema, backend);
    const expectedCount = (await query(engine)).value;
    let correctnessChecks = 1;
    const timing = { warmups, samples: iterations, operationsPerSample: 10 };
    const resident = await measureResident("resident-warm", timing, async () => {
      const result = await query(engine);
      if (result.value !== expectedCount) throw new Error("warm result changed");
      correctnessChecks++;
    });
    let coldPagesRead = 0;
    let coldBytesRead = 0;
    let coldRuns = 0;
    const coldCache = await measureEndToEnd("indexeddb-cold-cache", timing, async () => {
      engine.clearCache();
      const result = await query(engine);
      if (result.value !== expectedCount) throw new Error("cold-cache result changed");
      correctnessChecks++;
      coldPagesRead += result.stats.pagesRead;
      coldBytesRead += result.stats.bytesRead;
      coldRuns++;
    });
    engine[Symbol.dispose]();

    const reopened = await measureConstructionInclusive(
      "indexeddb-reopen",
      timing,
      async () => new SchemaEngine(benchmarkSchema, await IndexedDbPageBackend.open(databaseName)),
      async (reopened) => {
        const result = await query(reopened);
        if (result.value !== expectedCount) throw new Error("reopened result changed");
        correctnessChecks++;
      },
    );
    return createBenchmarkResult({
      name: "columnar-schema-engine/indexeddb-restoration",
      recordedAt: new Date().toISOString(),
      environment: detectBenchmarkEnvironment({
        runtimeName: "chromium",
        runtimeVersion: browserVersion(navigator.userAgent),
        cpu,
        adapter: null,
        crossOriginIsolated: globalThis.crossOriginIsolated,
      }),
      timing,
      input: {
        shape: {
          rows,
          rowGroups: Math.ceil(rows / BENCHMARK_ROW_GROUP_SIZE),
          selectedRowGroups: 1,
          columns: 3,
        },
        bytes: rows * 9,
      },
      correctness: {
        passed: true,
        checks: correctnessChecks,
        summary: `every query returned count ${expectedCount}`,
      },
      measurements: [resident, coldCache, reopened],
      metrics: {
        expectedCount,
        coldPagesRead: coldPagesRead / coldRuns,
        coldBytesRead: coldBytesRead / coldRuns,
      },
      notes: [
        "Cold cache clears resident host/Wasm pages but keeps the IndexedDB connection open.",
        "Reopen includes IndexedDB open, SchemaEngine construction, query, and disposal.",
      ],
    });
  } finally {
    await IndexedDbPageBackend.deleteDatabase(databaseName);
  }
}

function browserVersion(userAgent: string): string {
  return /(?:Chrome|Chromium)\/([^ ]+)/.exec(userAgent)?.[1] ?? userAgent;
}

Object.assign(globalThis, { benchmarkIndexedDbRestoration });

const parameters = new URLSearchParams(location.search);
if (parameters.get("benchmark") === "indexeddb") {
  const rows = Number(parameters.get("rows") ?? 4_194_304);
  const iterations = Number(parameters.get("iterations") ?? 30);
  const warmups = Number(parameters.get("warmups") ?? 5);
  const cpu = parameters.get("cpu") ?? "unavailable";
  benchmarkIndexedDbRestoration(rows, iterations, warmups, cpu)
    .then((result) =>
      fetch("/__jsimd_result", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(result),
      })
    )
    .catch((error) =>
      fetch("/__jsimd_result", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: error instanceof Error ? error.stack : String(error) }),
      })
    );
}
