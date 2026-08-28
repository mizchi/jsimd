import {
  defineSchema,
  defineTable,
  i32,
  MemoryPageBackend,
  SchemaEngine,
} from "@mizchi/jsimd-columnar";
import {
  CHROMIUM_I32_COUNT_SUM_COST_MODEL,
  I32AggregatePipeline,
} from "../../../packages/olap/src/range_aggregate.ts";

type Workload = "constant" | "for" | "raw";

interface AdaptiveMeasurement {
  readonly workload: Workload;
  readonly encoding: string;
  readonly physicalPages: number;
  readonly encodedPayloadBytes: number;
  readonly directSamplesMs: readonly number[];
  readonly workerSamplesMs: readonly number[];
  readonly planned: "direct" | "workers";
}

interface BrowserAdaptiveResult {
  readonly rows: number;
  readonly rowGroupRows: number;
  readonly workerCount: number;
  readonly measurements: readonly AdaptiveMeasurement[];
  readonly correctnessChecks: number;
  readonly crossOriginIsolated: boolean;
  readonly userAgent: string;
}

const MINIMUM = 0;
const MAXIMUM = 2_000_000;
const workloads = ["constant", "for", "raw"] as const;
const parameters = new URLSearchParams(location.search);
const rows = positiveInteger(parameters.get("rows") ?? String(1 << 23), "rows");
const rowGroupRows = positiveInteger(parameters.get("rowGroupRows") ?? "65536", "rowGroupRows");
const workerCount = Math.min(
  positiveInteger(parameters.get("workers") ?? "8", "workers"),
  Math.max(1, navigator.hardwareConcurrency || 1),
);
const warmups = positiveInteger(parameters.get("warmups") ?? "5", "warmups");
const samples = positiveInteger(parameters.get("samples") ?? "11", "samples");
const schema = defineSchema({
  events: defineTable({ value: i32() }, { rowGroupSize: rowGroupRows }),
});

void run().then(report, reportError);

async function run(): Promise<BrowserAdaptiveResult> {
  if (!crossOriginIsolated) throw new Error("benchmark requires COOP/COEP isolation");
  const measurements: AdaptiveMeasurement[] = [];
  let correctnessChecks = 0;
  let sink = 0n;
  for (const workload of workloads) {
    const values = createValues(workload, rows);
    const expected = scanReference(values);
    {
      using engine = new SchemaEngine(schema, new MemoryPageBackend());
      await engine.replace("events", { value: values });
      await using pipeline = await I32AggregatePipeline.createFromSchema(
        engine,
        "events",
        "value",
        { workerCount, costModel: CHROMIUM_I32_COUNT_SUM_COST_MODEL },
      );
      const directSamplesMs: number[] = [];
      const workerSamplesMs: number[] = [];
      for (let iteration = -warmups; iteration < samples; iteration++) {
        let started = performance.now();
        const direct = await pipeline.aggregateBetween(MINIMUM, MAXIMUM, { execution: "direct" });
        const directMs = performance.now() - started;
        started = performance.now();
        const workers = await pipeline.aggregateBetween(MINIMUM, MAXIMUM, {
          execution: "workers",
        });
        const workerMs = performance.now() - started;
        validate(direct.count, direct.sum, expected, `${workload}/direct`);
        validate(workers.count, workers.sum, expected, `${workload}/workers`);
        correctnessChecks += 2;
        sink ^= direct.sum ^ workers.sum;
        if (iteration >= 0) {
          directSamplesMs.push(directMs);
          workerSamplesMs.push(workerMs);
        }
      }
      const automatic = await pipeline.aggregateBetween(MINIMUM, MAXIMUM);
      validate(automatic.count, automatic.sum, expected, `${workload}/auto`);
      correctnessChecks++;
      sink ^= automatic.sum;
      const encodings = new Set(pipeline.chunk.pages.map((page) => page.encoding));
      if (encodings.size !== 1) throw new Error(`${workload} did not force one encoding`);
      measurements.push({
        workload,
        encoding: encodings.values().next().value!,
        physicalPages: pipeline.chunk.pages.length,
        encodedPayloadBytes: pipeline.encodedPayloadBytes,
        directSamplesMs,
        workerSamplesMs,
        planned: automatic.plan.execution,
      });
    }
  }
  if (sink === -1n) throw new Error("unreachable benchmark sink");
  return {
    rows,
    rowGroupRows,
    workerCount,
    measurements,
    correctnessChecks,
    crossOriginIsolated,
    userAgent: navigator.userAgent,
  };
}

function createValues(workload: Workload, length: number): Int32Array {
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

function scanReference(values: Int32Array): { count: number; sum: bigint } {
  let count = 0;
  let sum = 0n;
  for (const value of values) {
    if (value < MINIMUM || value >= MAXIMUM) continue;
    count++;
    sum += BigInt(value);
  }
  return { count, sum };
}

function validate(
  count: number,
  sum: bigint,
  expected: { count: number; sum: bigint },
  name: string,
): void {
  if (count !== expected.count || sum !== expected.sum) {
    throw new Error(`${name} returned an incorrect aggregate`);
  }
}

async function report(result: BrowserAdaptiveResult): Promise<void> {
  await fetch("/__jsimd_result", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(result),
  });
}

async function reportError(error: unknown): Promise<void> {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  await fetch("/__jsimd_result", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ error: message }),
  });
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be positive`);
  return parsed;
}
