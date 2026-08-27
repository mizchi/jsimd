import { detectHostCpu, runBrowserBenchmark } from "../packages/bench/src/browser_runner.ts";
import { type BenchmarkResultV1, validateBenchmarkResult } from "../packages/bench/src/result.ts";

const root = new URL(
  "../packages/columnar/fixtures/browser-benchmark/dist/",
  import.meta.url,
);
const rows = positiveInteger(Deno.env.get("JSIMD_INDEXEDDB_ROWS") ?? "4194304", "rows");
const warmups = nonNegativeInteger(
  Deno.env.get("JSIMD_INDEXEDDB_WARMUPS") ?? "5",
  "warmups",
);
const samples = positiveInteger(
  Deno.env.get("JSIMD_INDEXEDDB_SAMPLES") ??
    Deno.env.get("JSIMD_INDEXEDDB_ITERATIONS") ?? "30",
  "samples",
);

const result = await runBrowserBenchmark<BenchmarkResultV1>({
  root,
  query: {
    benchmark: "indexeddb",
    rows,
    warmups,
    iterations: samples,
    cpu: await detectHostCpu(),
  },
  profilePrefix: "jsimd-columnar-indexeddb-",
  browserArgs: ["--disable-gpu"],
  crossOriginIsolated: false,
  validate: validateBenchmarkResult,
});
const json = JSON.stringify(result, null, 2) + "\n";
const output = Deno.env.get("JSIMD_INDEXEDDB_OUTPUT");
if (output !== undefined) await Deno.writeTextFile(output, json);
console.log(json);

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return parsed;
}
