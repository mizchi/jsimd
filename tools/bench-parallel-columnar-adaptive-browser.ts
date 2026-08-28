import { detectHostCpu, runBrowserBenchmark } from "../packages/bench/src/browser_runner.ts";
import { summarizeBenchmarkSamples } from "../packages/bench/src/measure.ts";
import { createBenchmarkResult, validateBenchmarkResult } from "../packages/bench/src/result.ts";

const root = new URL(
  "../experiments/parallel-columnar-query/browser-adaptive-pipeline/dist/",
  import.meta.url,
);
const rows = positiveInteger(Deno.env.get("JSIMD_ADAPTIVE_ROWS") ?? String(1 << 23), "rows");
const rowGroupRows = positiveInteger(
  Deno.env.get("JSIMD_ADAPTIVE_ROW_GROUP_ROWS") ?? "65536",
  "rowGroupRows",
);
const workers = positiveInteger(Deno.env.get("JSIMD_ADAPTIVE_WORKERS") ?? "8", "workers");
const warmups = positiveInteger(Deno.env.get("JSIMD_QUERY_WARMUPS") ?? "5", "warmups");
const samples = positiveInteger(Deno.env.get("JSIMD_QUERY_SAMPLES") ?? "11", "samples");
const raw = await runBrowserBenchmark<BrowserAdaptiveResult>({
  root,
  query: { rows, rowGroupRows, workers, warmups, samples },
  profilePrefix: "jsimd-adaptive-pipeline-",
  browserArgs: ["--disable-gpu"],
  crossOriginIsolated: true,
  validate: validateBrowserResult,
});
const measurements = raw.measurements.flatMap((measurement) => [
  summarizeBenchmarkSamples(
    `direct/${measurement.workload}`,
    "resident",
    measurement.directSamplesMs,
  ),
  summarizeBenchmarkSamples(
    `workers/${measurement.workload}`,
    "resident",
    measurement.workerSamplesMs,
  ),
]);
const metrics: Record<string, number | string | boolean> = {};
let plannerMatchesFastest = 0;
for (const measurement of raw.measurements) {
  const directMedian = median(measurement.directSamplesMs);
  const workerMedian = median(measurement.workerSamplesMs);
  const fastest = workerMedian < directMedian ? "workers" : "direct";
  if (measurement.planned === fastest) plannerMatchesFastest++;
  metrics[`encoding_${measurement.workload}`] = measurement.encoding;
  metrics[`physicalPages_${measurement.workload}`] = measurement.physicalPages;
  metrics[`encodedPayloadBytes_${measurement.workload}`] = measurement.encodedPayloadBytes;
  metrics[`fastest_${measurement.workload}`] = fastest;
  metrics[`planned_${measurement.workload}`] = measurement.planned;
  metrics[`speedup_${measurement.workload}`] = round(
    Math.max(directMedian, workerMedian) / Math.min(directMedian, workerMedian),
  );
}
const chromiumVersion = /(?:Chrome|Chromium)\/([^ ]+)/.exec(raw.userAgent)?.[1] ?? "unknown";
const result = createBenchmarkResult({
  name: "parallel-columnar-query/browser-adaptive-schema-pipeline",
  recordedAt: new Date().toISOString(),
  environment: {
    runtime: { name: "chromium", version: chromiumVersion, userAgent: raw.userAgent },
    platform: Deno.build.target,
    logicalCpus: navigator.hardwareConcurrency,
    cpu: await detectHostCpu(),
    adapter: null,
    crossOriginIsolated: raw.crossOriginIsolated,
  },
  timing: { warmups, samples, operationsPerSample: 1 },
  input: {
    shape: {
      rows: raw.rows,
      rowGroupRows: raw.rowGroupRows,
      adaptivePageRows: 256,
      workers: raw.workerCount,
      encodings: raw.measurements.map((measurement) => measurement.workload).join(","),
    },
    bytes: raw.rows * 4,
  },
  correctness: {
    passed: true,
    checks: raw.correctnessChecks,
    summary: "direct, Worker, and automatic adaptive scans returned identical count and sum",
  },
  measurements,
  metrics: {
    plannerMatchesFastest,
    plannerDecisionCount: raw.measurements.length,
    ...metrics,
  },
  notes: [
    "Each encoding is built and copied into shared memory before resident timing begins.",
    "Direct and Worker measurements alternate in one isolated Chrome process.",
    "Every 256-row page is forced into constant, 8-bit FOR, or raw encoding.",
  ],
});
validateBenchmarkResult(result);
const json = JSON.stringify(result, null, 2) + "\n";
const output = Deno.env.get("JSIMD_BROWSER_ADAPTIVE_OUTPUT");
if (output !== undefined) await Deno.writeTextFile(output, json);
console.log(json);

type Workload = "constant" | "for" | "raw";

interface BrowserAdaptiveMeasurement {
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
  readonly measurements: readonly BrowserAdaptiveMeasurement[];
  readonly correctnessChecks: number;
  readonly crossOriginIsolated: boolean;
  readonly userAgent: string;
}

function validateBrowserResult(value: unknown): asserts value is BrowserAdaptiveResult {
  if (typeof value !== "object" || value === null) throw new Error("invalid browser result");
  const result = value as Partial<BrowserAdaptiveResult>;
  if (
    !Number.isSafeInteger(result.rows) || !Number.isSafeInteger(result.rowGroupRows) ||
    !Number.isSafeInteger(result.workerCount) || !Array.isArray(result.measurements) ||
    !Number.isSafeInteger(result.correctnessChecks) || result.crossOriginIsolated !== true ||
    typeof result.userAgent !== "string"
  ) throw new Error("invalid browser adaptive pipeline result");
  for (const measurement of result.measurements) {
    if (
      !["constant", "for", "raw"].includes(measurement.workload) ||
      typeof measurement.encoding !== "string" ||
      !Number.isSafeInteger(measurement.physicalPages) ||
      !Number.isSafeInteger(measurement.encodedPayloadBytes) ||
      !Array.isArray(measurement.directSamplesMs) ||
      !Array.isArray(measurement.workerSamplesMs) ||
      (measurement.planned !== "direct" && measurement.planned !== "workers")
    ) throw new Error("invalid browser adaptive measurement");
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
