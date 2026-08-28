import { detectHostCpu, runBrowserBenchmark } from "../packages/bench/src/browser_runner.ts";
import { summarizeBenchmarkSamples } from "../packages/bench/src/measure.ts";
import { createBenchmarkResult, validateBenchmarkResult } from "../packages/bench/src/result.ts";

const root = new URL(
  "../experiments/parallel-columnar-query/browser-physical-pipeline/dist/",
  import.meta.url,
);
const rows = positiveInteger(Deno.env.get("JSIMD_PIPELINE_ROWS") ?? String(1 << 25), "rows");
const pageRows = positiveInteger(Deno.env.get("JSIMD_PIPELINE_PAGE_ROWS") ?? "65536", "pageRows");
const workers = positiveInteger(Deno.env.get("JSIMD_PIPELINE_WORKERS") ?? "8", "workers");
const warmups = positiveInteger(Deno.env.get("JSIMD_QUERY_WARMUPS") ?? "5", "warmups");
const samples = positiveInteger(Deno.env.get("JSIMD_QUERY_SAMPLES") ?? "11", "samples");
const cpu = await detectHostCpu();
const raw = await runBrowserBenchmark<BrowserPhysicalResult>({
  root,
  query: { rows, pageRows, workers, warmups, samples },
  profilePrefix: "jsimd-physical-pipeline-",
  browserArgs: ["--disable-gpu"],
  crossOriginIsolated: true,
  validate: validateBrowserResult,
});
const measurements = raw.measurements.flatMap((measurement) => [
  summarizeBenchmarkSamples(
    `direct/${measurement.pages}-pages`,
    "resident",
    measurement.directSamplesMs,
  ),
  summarizeBenchmarkSamples(
    `workers/${measurement.pages}-pages`,
    "resident",
    measurement.workerSamplesMs,
  ),
]);
const decisions: Record<string, string | number> = {};
let plannerMatchesFastest = 0;
let plannerWithinFivePercent = 0;
for (const measurement of raw.measurements) {
  const directMedian = median(measurement.directSamplesMs);
  const workerMedian = median(measurement.workerSamplesMs);
  const fastest = workerMedian < directMedian ? "workers" : "direct";
  if (measurement.planned === fastest) plannerMatchesFastest++;
  const plannedMs = measurement.planned === "workers" ? workerMedian : directMedian;
  const fastestMs = Math.min(directMedian, workerMedian);
  if (plannedMs <= fastestMs * 1.05) plannerWithinFivePercent++;
  decisions[`fastest_${measurement.pages}_pages`] = fastest;
  decisions[`planned_${measurement.pages}_pages`] = measurement.planned;
  decisions[`speedup_${measurement.pages}_pages`] = round(
    Math.max(directMedian, workerMedian) / fastestMs,
  );
}
const chromiumVersion = /(?:Chrome|Chromium)\/([^ ]+)/.exec(raw.userAgent)?.[1] ?? "unknown";
const result = createBenchmarkResult({
  name: "parallel-columnar-query/browser-physical-pipeline-crossover",
  recordedAt: new Date().toISOString(),
  environment: {
    runtime: { name: "chromium", version: chromiumVersion, userAgent: raw.userAgent },
    platform: Deno.build.target,
    logicalCpus: navigator.hardwareConcurrency,
    cpu,
    adapter: null,
    crossOriginIsolated: raw.crossOriginIsolated,
  },
  timing: { warmups, samples, operationsPerSample: 1 },
  input: {
    shape: {
      rows: raw.rows,
      pageRows: raw.pageRows,
      totalPages: Math.ceil(raw.rows / raw.pageRows),
      survivingPages: raw.measurements.map((measurement) => measurement.pages).join(","),
      workers: raw.workerCount,
    },
    bytes: raw.rows * 4,
  },
  correctness: {
    passed: true,
    checks: raw.correctnessChecks,
    summary: "direct, Worker, and automatic execution returned identical count and sum",
  },
  measurements,
  metrics: {
    initializationMs: round(raw.initializationMs),
    plannerMatchesFastest,
    plannerWithinFivePercent,
    plannerDecisionCount: raw.measurements.length,
    ...decisions,
  },
  notes: [
    "Direct and Worker measurements alternate in one isolated Chrome process over resident data.",
    "Automatic execution uses a Chromium-specific raw count+sum profile, not the Deno dispatch cost.",
    "Construction, input copy, Wasm instantiation, and Worker startup are excluded from query latency.",
  ],
});
validateBenchmarkResult(result);
const json = JSON.stringify(result, null, 2) + "\n";
const output = Deno.env.get("JSIMD_BROWSER_PIPELINE_OUTPUT");
if (output !== undefined) await Deno.writeTextFile(output, json);
console.log(json);

interface BrowserPhysicalMeasurement {
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
  readonly measurements: readonly BrowserPhysicalMeasurement[];
  readonly correctnessChecks: number;
  readonly crossOriginIsolated: boolean;
  readonly userAgent: string;
}

function validateBrowserResult(value: unknown): asserts value is BrowserPhysicalResult {
  if (typeof value !== "object" || value === null) throw new Error("invalid browser result");
  const result = value as Partial<BrowserPhysicalResult>;
  if (
    !Number.isSafeInteger(result.rows) || !Number.isSafeInteger(result.pageRows) ||
    !Number.isSafeInteger(result.workerCount) || !Number.isFinite(result.initializationMs) ||
    !Array.isArray(result.measurements) || !Number.isSafeInteger(result.correctnessChecks) ||
    result.crossOriginIsolated !== true || typeof result.userAgent !== "string"
  ) throw new Error("invalid browser physical pipeline result");
  for (const measurement of result.measurements) {
    if (
      !Number.isSafeInteger(measurement.pages) || !Array.isArray(measurement.directSamplesMs) ||
      !Array.isArray(measurement.workerSamplesMs) ||
      (measurement.planned !== "direct" && measurement.planned !== "workers")
    ) throw new Error("invalid browser physical measurement");
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be positive`);
  return parsed;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
