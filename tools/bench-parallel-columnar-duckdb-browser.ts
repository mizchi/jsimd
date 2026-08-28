import { detectHostCpu, runBrowserBenchmark } from "../packages/bench/src/browser_runner.ts";
import { gzipSize } from "../packages/bench/src/build_budget.ts";
import { summarizeBenchmarkSamples } from "../packages/bench/src/measure.ts";
import { createBenchmarkResult, validateBenchmarkResult } from "../packages/bench/src/result.ts";

const root = new URL(
  "../experiments/parallel-columnar-query/duckdb-comparison/dist/",
  import.meta.url,
);
const requestedRows = Deno.env.get("JSIMD_QUERY_ROWS");
const sparseGroupCount = parsePositiveInteger(
  Deno.env.get("JSIMD_QUERY_GROUPS") ?? "2048",
  "groups",
);
const modes = ["jsimd-single", "jsimd-workers", "duckdb-eh", "duckdb-coi"] as const;
const requestedWorkload = Deno.env.get("JSIMD_QUERY_WORKLOAD");
const workloads = requestedWorkload === undefined
  ? ["q6", "q1", "logs", "sparse"] as const
  : [parseWorkload(requestedWorkload)] as const;
const cpu = await detectHostCpu();
const outputDirectory = Deno.env.get("JSIMD_DUCKDB_OUTPUT_DIR");
const allResults: BrowserResult[] = [];

for (const workload of workloads) {
  const rows = parsePositiveInteger(
    requestedRows ?? (workload === "q6" ? "33554432" : "16777216"),
    "rows",
  );
  const workloadResults: BrowserResult[] = [];
  for (const mode of modes) {
    const result = await runBrowserBenchmark<BrowserResult>({
      root,
      query: { mode, workload, rows, groups: sparseGroupCount },
      profilePrefix: `jsimd-duckdb-${workload}-${mode}-`,
      browserArgs: ["--disable-gpu"],
      crossOriginIsolated: true,
    });
    workloadResults.push(result);
    allResults.push(result);
    console.log(JSON.stringify(result));
  }
  const result = await createWorkloadResult(workload, rows, workloadResults, cpu);
  validateBenchmarkResult(result);
  if (outputDirectory !== undefined) {
    await Deno.mkdir(outputDirectory, { recursive: true });
    const filename = workload === "q6" ? "duckdb-browser.json" : `duckdb-browser-${workload}.json`;
    await Deno.writeTextFile(
      `${outputDirectory}/${filename}`,
      JSON.stringify(result, null, 2) + "\n",
    );
  }
  console.log(JSON.stringify(result, null, 2));
}
console.log(JSON.stringify({ workloads, results: allResults }, null, 2));

interface BrowserResult {
  readonly mode: typeof modes[number];
  readonly workload: "q6" | "q1" | "logs" | "sparse";
  readonly rows: number;
  readonly bytes: number;
  readonly workerCount: number;
  readonly groupCount?: number;
  readonly initializationMs: number;
  readonly medianMs: number;
  readonly samplesMs: readonly number[];
  readonly crossOriginIsolated: boolean;
  readonly userAgent: string;
  readonly duckdbVersion?: string;
  readonly duckdbConfiguredThreads?: number;
}

async function createWorkloadResult(
  workload: "q6" | "q1" | "logs" | "sparse",
  rows: number,
  results: readonly BrowserResult[],
  cpu: string,
) {
  if (results.length !== modes.length) throw new Error("every comparison mode must complete");
  const samples = results[0]!.samplesMs.length;
  if (samples === 0 || results.some((result) => result.samplesMs.length !== samples)) {
    throw new Error("comparison modes must contain equal non-empty raw sample counts");
  }
  const userAgent = results[0]!.userAgent;
  const chromiumVersion = /(?:Chrome|Chromium)\/([^ ]+)/.exec(userAgent)?.[1] ?? "unknown";
  const metrics: Record<string, number | string | boolean> = {};
  for (const result of results) {
    const key = result.mode.replaceAll("-", "_");
    metrics[`initializationMs_${key}`] = result.initializationMs;
    metrics[`workers_${key}`] = result.workerCount;
    if (result.duckdbVersion !== undefined) metrics[`version_${key}`] = result.duckdbVersion;
    if (result.duckdbConfiguredThreads !== undefined) {
      metrics[`configuredThreads_${key}`] = result.duckdbConfiguredThreads;
    }
  }
  Object.assign(metrics, await bundledAssetMetrics(workload));
  return createBenchmarkResult({
    name: `parallel-columnar-query/duckdb-browser-${workload}`,
    recordedAt: new Date().toISOString(),
    environment: {
      runtime: { name: "chromium", version: chromiumVersion, userAgent },
      platform: Deno.build.target,
      logicalCpus: navigator.hardwareConcurrency,
      cpu,
      adapter: null,
      crossOriginIsolated: results.every((result) => result.crossOriginIsolated),
    },
    timing: { warmups: 5, samples, operationsPerSample: 1 },
    input: {
      shape: {
        workload,
        rows,
        selectivity: workload === "q6" ? 0.25 : workload === "q1" ? 0.5 : 0.1,
        groupCount: workload === "q6"
          ? 0
          : workload === "sparse"
          ? results[0]!.groupCount ?? sparseGroupCount
          : 8,
      },
      bytes: results[0]!.bytes,
    },
    correctness: {
      passed: true,
      checks: results.length,
      summary: workload === "q6"
        ? "all count and sum outputs matched"
        : workload === "sparse"
        ? "all sparse u32 group nullable count, sum, minimum, and maximum outputs matched"
        : "all eight group count, sum, minimum, and maximum outputs matched",
    },
    measurements: results.map((result) =>
      summarizeBenchmarkSamples(
        `${result.mode}/workers=${result.workerCount}`,
        "end-to-end",
        result.samplesMs,
      )
    ),
    metrics,
    notes: [
      "Each end-to-end boundary is one warm query over a resident table and includes caller-visible result materialization; engine and table construction are excluded.",
      "Each mode runs in a fresh browser process with explicit DuckDB eh or coi bundle selection.",
    ],
  });
}

async function bundledAssetMetrics(
  workload: "q6" | "q1" | "logs",
): Promise<Record<string, number>> {
  const assets = new URL("assets/", root);
  const entries: { name: string; gzipBytes: number }[] = [];
  for await (const entry of Deno.readDir(assets)) {
    if (!entry.isFile) continue;
    const bytes = await Deno.readFile(new URL(entry.name, assets));
    entries.push({
      name: entry.name,
      gzipBytes: await gzipSize(bytes),
    });
  }
  const sum = (predicate: (name: string) => boolean) =>
    entries.filter((entry) => predicate(entry.name)).reduce(
      (total, entry) => total + entry.gzipBytes,
      0,
    );
  return {
    bundleGzipBytesJsimdWasm: sum((name) => name.startsWith("kernels-") && name.endsWith(".wasm")),
    bundleGzipBytesJsimdWorker: sum((name) =>
      workload === "q6"
        ? /^worker-.*\.js$/.test(name)
        : workload === "sparse"
        ? /^local_group_hash_worker-.*\.js$/.test(name)
        : /^group_worker-.*\.js$/.test(name)
    ),
    bundleGzipBytesDuckdbEhWasm: sum((name) =>
      name.startsWith("duckdb-eh-") && name.endsWith(".wasm")
    ),
    bundleGzipBytesDuckdbEhWorker: sum((name) => name.includes("browser-eh.worker")),
    bundleGzipBytesDuckdbCoiWasm: sum((name) =>
      name.startsWith("duckdb-coi-") && name.endsWith(".wasm")
    ),
    bundleGzipBytesDuckdbCoiWorkers: sum((name) =>
      name.includes("browser-coi.worker") || name.includes("browser-coi.pthread.worker")
    ),
  };
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

function parseWorkload(value: string): "q6" | "q1" | "logs" | "sparse" {
  if (value === "q6" || value === "q1" || value === "logs" || value === "sparse") return value;
  throw new Error(`JSIMD_QUERY_WORKLOAD must be q6, q1, logs, or sparse, got ${value}`);
}
