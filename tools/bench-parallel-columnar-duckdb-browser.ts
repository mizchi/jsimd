import { runBrowserBenchmark } from "./benchmark/browser_runner.ts";

const root = new URL(
  "../experiments/parallel-columnar-query/duckdb-comparison/dist/",
  import.meta.url,
);
const rows = parsePositiveInteger(Deno.env.get("JSIMD_QUERY_ROWS") ?? "33554432", "rows");
const modes = ["jsimd-single", "jsimd-workers", "duckdb-eh", "duckdb-coi"] as const;
const requestedWorkload = Deno.env.get("JSIMD_QUERY_WORKLOAD");
const workloads = requestedWorkload === undefined
  ? ["q6", "q1", "logs"] as const
  : [parseWorkload(requestedWorkload)] as const;
const results: unknown[] = [];

for (const workload of workloads) {
  for (const mode of modes) {
    const result = await runBrowserBenchmark({
      root,
      query: { mode, workload, rows },
      profilePrefix: `jsimd-duckdb-${workload}-${mode}-`,
      browserArgs: ["--disable-gpu"],
      crossOriginIsolated: true,
    });
    results.push(result);
    console.log(JSON.stringify(result));
  }
}
console.log(JSON.stringify({ rows, workloads, results }, null, 2));

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

function parseWorkload(value: string): "q6" | "q1" | "logs" {
  if (value === "q6" || value === "q1" || value === "logs") return value;
  throw new Error(`JSIMD_QUERY_WORKLOAD must be q6, q1, or logs, got ${value}`);
}
