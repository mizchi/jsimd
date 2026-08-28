import { detectHostCpu } from "@mizchi/jsimd-bench/browser-runner";
import { summarizeBenchmarkSamples } from "@mizchi/jsimd-bench/measure";
import { createBenchmarkResult, detectBenchmarkEnvironment } from "@mizchi/jsimd-bench/result";
import {
  defineSchema,
  defineTable,
  i32,
  MemoryPageBackend,
  SchemaEngine,
} from "@mizchi/jsimd-columnar";
import { I32AggregatePipeline } from "../../packages/olap/src/physical_pipeline.ts";

const MINIMUM = 0;
const MAXIMUM = 2_000_000;

const ROWS = Number(Deno.env.get("JSIMD_ADAPTIVE_ROWS") ?? 1 << 23);
const ROW_GROUP_ROWS = Number(Deno.env.get("JSIMD_ADAPTIVE_ROW_GROUP_ROWS") ?? 65_536);
const WORKERS = Number(Deno.env.get("JSIMD_ADAPTIVE_WORKERS") ?? 8);
const WARMUPS = Number(Deno.env.get("JSIMD_QUERY_WARMUPS") ?? 5);
const SAMPLES = Number(Deno.env.get("JSIMD_QUERY_SAMPLES") ?? 11);
const workloads = ["constant", "for", "raw"] as const;

const schema = defineSchema({
  events: defineTable({ value: i32() }, { rowGroupSize: ROW_GROUP_ROWS }),
});
const measurements = [];
const metrics: Record<string, number | string | boolean> = {};
let correctnessChecks = 0;
let sink = 0n;

for (const workload of workloads) {
  const values = createValues(workload, ROWS);
  const expected = scanJavaScript(values, MINIMUM, MAXIMUM);
  const backend = new MemoryPageBackend();
  using engine = new SchemaEngine(schema, backend);
  await engine.replace("events", { value: values });
  const stored = await engine.readI32SnapshotPages("events", "value");

  const constructionSamples = await measureAsync(async () => {
    await using pipeline = await I32AggregatePipeline.createFromSchema(
      engine,
      "events",
      "value",
      { workerCount: WORKERS },
    );
    sink ^= pipeline.encodedPayloadBytes === 0 ? 0n : BigInt(pipeline.encodedPayloadBytes);
  }, 1);

  await using pipeline = await I32AggregatePipeline.createFromSchema(
    engine,
    "events",
    "value",
    { workerCount: WORKERS },
  );
  const directCheck = await pipeline.aggregateBetween(MINIMUM, MAXIMUM, {
    execution: "direct",
  });
  const workerCheck = await pipeline.aggregateBetween(MINIMUM, MAXIMUM, {
    execution: "workers",
  });
  const automaticCheck = await pipeline.aggregateBetween(MINIMUM, MAXIMUM);
  for (
    const [name, result] of [
      ["direct", directCheck],
      ["workers", workerCheck],
      ["automatic", automaticCheck],
    ] as const
  ) {
    if (result.count !== expected.count || result.sum !== BigInt(expected.sum)) {
      throw new Error(`${workload}/${name} returned an incorrect aggregate`);
    }
    correctnessChecks++;
  }
  if (engine.cacheStats().pages !== 0) throw new Error("benchmark populated resident cache");

  const jsSamples = measureSync(() => {
    const result = scanJavaScript(values, MINIMUM, MAXIMUM);
    sink ^= BigInt(result.sum);
  });
  const directSamples = await measureAsync(async () => {
    sink ^= (await pipeline.aggregateBetween(MINIMUM, MAXIMUM, {
      execution: "direct",
    })).sum;
  });
  const workerSamples = await measureAsync(async () => {
    sink ^= (await pipeline.aggregateBetween(MINIMUM, MAXIMUM, {
      execution: "workers",
    })).sum;
  });

  const jsSummary = summarizeBenchmarkSamples(`js/${workload}`, "resident", jsSamples);
  const directSummary = summarizeBenchmarkSamples(
    `direct/${workload}`,
    "resident",
    directSamples,
  );
  const workerSummary = summarizeBenchmarkSamples(
    `workers/${workload}`,
    "resident",
    workerSamples,
  );
  measurements.push(
    jsSummary,
    directSummary,
    workerSummary,
    summarizeBenchmarkSamples(
      `schema-to-shared/${workload}`,
      "construction-inclusive",
      constructionSamples,
    ),
  );
  metrics[`storedBytes_${workload}`] = stored.bytesRead;
  metrics[`encodedPayloadBytes_${workload}`] = pipeline.encodedPayloadBytes;
  metrics[`sharedPayloadRatio_${workload}`] = round(
    pipeline.encodedPayloadBytes / values.byteLength,
  );
  metrics[`physicalPages_${workload}`] = pipeline.chunk.pages.length;
  metrics[`compressionRatio_${workload}`] = round(
    values.byteLength / Math.max(1, stored.bytesRead),
  );
  const fastest = workerSummary.medianMs < directSummary.medianMs ? "workers" : "direct";
  const expectedEncoding = workload === "for" ? "frame-of-reference" : workload;
  if (!pipeline.chunk.pages.every((page) => page.encoding === expectedEncoding)) {
    throw new Error(`${workload} fixture did not force the expected encoding`);
  }
  metrics[`fastest_${workload}`] = fastest;
  metrics[`planned_${workload}`] = automaticCheck.plan.execution;
  metrics[`estimatedDirectMs_${workload}`] = round(automaticCheck.plan.estimatedDirectMs);
  metrics[`estimatedWorkerMs_${workload}`] = round(automaticCheck.plan.estimatedWorkerMs);
  metrics[`speedupVsJsDirect_${workload}`] = round(jsSummary.medianMs / directSummary.medianMs);
  metrics[`speedupVsJsWorkers_${workload}`] = round(jsSummary.medianMs / workerSummary.medianMs);
}

const result = createBenchmarkResult({
  name: "parallel-columnar-query/adaptive-schema-pipeline",
  recordedAt: new Date().toISOString(),
  environment: detectBenchmarkEnvironment({
    logicalCpus: navigator.hardwareConcurrency,
    cpu: await detectHostCpu(),
    adapter: null,
  }),
  timing: { warmups: WARMUPS, samples: SAMPLES, operationsPerSample: 1 },
  input: {
    shape: {
      rows: ROWS,
      rowGroupRows: ROW_GROUP_ROWS,
      adaptivePageRows: 256,
      workers: WORKERS,
      encodings: workloads.join(","),
    },
    bytes: ROWS * 4,
  },
  correctness: {
    passed: true,
    checks: correctnessChecks,
    summary: "optimized JavaScript, direct Wasm, and Worker scans returned identical count and sum",
  },
  measurements,
  metrics: { ...metrics, sink: sink.toString() },
  notes: [
    "SchemaEngine replacement is complete before timing; resident scans include no backend reads.",
    "schema-to-shared includes backend snapshot reads, validation, encoded payload copies, shared allocation, Wasm instantiation, Worker startup, and disposal.",
    "The timed JavaScript baseline uses Number count/sum over fixtures whose exact sum remains within Number.MAX_SAFE_INTEGER.",
    "The three fixtures force every 256-row physical page into constant, 8-bit FOR, or raw encoding respectively.",
  ],
});
const json = JSON.stringify(result, null, 2) + "\n";
const output = Deno.env.get("JSIMD_ADAPTIVE_OUTPUT");
if (output !== undefined) await Deno.writeTextFile(output, json);
console.log(json);

function createValues(workload: typeof workloads[number], length: number): Int32Array {
  if (workload === "constant") {
    return Int32Array.from({ length }, (_, index) => (index >>> 8) & 1023);
  }
  if (workload === "for") {
    return Int32Array.from(
      { length },
      (_, index) => (((index >>> 8) & 1023) << 9) + (index & 255),
    );
  }
  return Int32Array.from({ length }, (_, index) => {
    const low = Math.imul(index ^ 0x5a5a_5a5a, 1_103_515_245) >>> 24;
    return (index & 1) * 1_000_000 + low;
  });
}

function scanJavaScript(
  input: Int32Array,
  minimum: number,
  maximum: number,
): { count: number; sum: number } {
  let count = 0;
  let sum = 0;
  for (let index = 0; index < input.length; index++) {
    const value = input[index]!;
    if (value >= minimum && value < maximum) {
      count++;
      sum += value;
    }
  }
  if (!Number.isSafeInteger(sum)) throw new Error("JavaScript reference sum is not exact");
  return { count, sum };
}

async function measureAsync(
  operation: () => Promise<void>,
  warmups = WARMUPS,
): Promise<number[]> {
  for (let warmup = 0; warmup < warmups; warmup++) await operation();
  const samples: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample++) {
    const start = performance.now();
    await operation();
    samples.push(performance.now() - start);
  }
  return samples;
}

function measureSync(operation: () => void): number[] {
  for (let warmup = 0; warmup < WARMUPS; warmup++) operation();
  const samples: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample++) {
    const start = performance.now();
    operation();
    samples.push(performance.now() - start);
  }
  return samples;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
