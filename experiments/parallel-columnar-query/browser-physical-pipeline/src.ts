import {
  CHROMIUM_I32_COUNT_SUM_COST_MODEL,
  I32AggregatePipeline,
} from "../../../packages/olap/src/range_aggregate.ts";

interface Measurement {
  readonly pages: number;
  readonly directSamplesMs: readonly number[];
  readonly workerSamplesMs: readonly number[];
  readonly planned: "direct" | "workers";
}

interface BrowserPhysicalResult {
  readonly rows: number;
  readonly pageRows: number;
  readonly workerCount: number;
  readonly initializationMs: number;
  readonly measurements: readonly Measurement[];
  readonly correctnessChecks: number;
  readonly crossOriginIsolated: boolean;
  readonly userAgent: string;
}

const parameters = new URLSearchParams(location.search);
const rows = positiveInteger(parameters.get("rows") ?? String(1 << 25), "rows");
const pageRows = positiveInteger(parameters.get("pageRows") ?? "65536", "pageRows");
const workerCount = Math.min(
  positiveInteger(parameters.get("workers") ?? "8", "workers"),
  Math.max(1, navigator.hardwareConcurrency || 1),
);
const warmups = positiveInteger(parameters.get("warmups") ?? "5", "warmups");
const samples = positiveInteger(parameters.get("samples") ?? "11", "samples");
const pageCounts = [1, 4, 16, 32, 64, 128, 256, 512].filter(
  (pages) => pages * pageRows <= rows,
);

void run().then(report, reportError);

async function run(): Promise<BrowserPhysicalResult> {
  if (!crossOriginIsolated) throw new Error("benchmark requires COOP/COEP isolation");
  const values = Int32Array.from({ length: rows }, (_, index) => index);
  const initialized = performance.now();
  await using pipeline = await I32AggregatePipeline.create(values, {
    workerCount,
    pageRows,
    costModel: CHROMIUM_I32_COUNT_SUM_COST_MODEL,
  });
  const initializationMs = performance.now() - initialized;
  const measurements: Measurement[] = [];
  let correctnessChecks = 0;
  let sink = 0n;

  for (const pages of pageCounts) {
    const maximum = pages * pageRows;
    const expectedCount = maximum;
    const expectedSum = BigInt(maximum) * BigInt(maximum - 1) / 2n;
    const directSamplesMs: number[] = [];
    const workerSamplesMs: number[] = [];
    for (let iteration = -warmups; iteration < samples; iteration++) {
      let started = performance.now();
      const direct = await pipeline.aggregateBetween(0, maximum, { execution: "direct" });
      const directMs = performance.now() - started;
      started = performance.now();
      const workers = await pipeline.aggregateBetween(0, maximum, { execution: "workers" });
      const workerMs = performance.now() - started;
      validate(direct.count, direct.sum, expectedCount, expectedSum, `direct/${pages}`);
      validate(workers.count, workers.sum, expectedCount, expectedSum, `workers/${pages}`);
      correctnessChecks += 2;
      sink ^= direct.sum ^ workers.sum;
      if (iteration >= 0) {
        directSamplesMs.push(directMs);
        workerSamplesMs.push(workerMs);
      }
    }
    const automatic = await pipeline.aggregateBetween(0, maximum);
    validate(automatic.count, automatic.sum, expectedCount, expectedSum, `auto/${pages}`);
    correctnessChecks++;
    sink ^= automatic.sum;
    measurements.push({
      pages,
      directSamplesMs,
      workerSamplesMs,
      planned: automatic.plan.execution,
    });
  }
  if (sink === -1n) throw new Error("unreachable benchmark sink");
  return {
    rows,
    pageRows,
    workerCount,
    initializationMs,
    measurements,
    correctnessChecks,
    crossOriginIsolated,
    userAgent: navigator.userAgent,
  };
}

function validate(
  count: number,
  sum: bigint,
  expectedCount: number,
  expectedSum: bigint,
  name: string,
): void {
  if (count !== expectedCount || sum !== expectedSum) {
    throw new Error(`${name} returned an incorrect aggregate`);
  }
}

async function report(result: BrowserPhysicalResult): Promise<void> {
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
