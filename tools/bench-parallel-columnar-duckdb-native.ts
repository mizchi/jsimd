import { detectHostCpu } from "../packages/bench/src/browser_runner.ts";
import { summarizeBenchmarkSamples } from "../packages/bench/src/measure.ts";
import {
  createBenchmarkResult,
  detectBenchmarkEnvironment,
  validateBenchmarkResult,
} from "../packages/bench/src/result.ts";
import {
  extractDuckDbProfiles,
  type NativeDuckDbWorkload,
  nativeDuckDbWorkload,
  type NativeDuckDbWorkloadName,
  validateNativeDuckDbResult,
} from "./duckdb-native-workload.ts";

const warmups = 5;
const samples = 11;
const processRepeats = positiveInteger(
  Deno.env.get("JSIMD_DUCKDB_NATIVE_REPEATS") ?? "3",
  "repeats",
);
const executable = Deno.env.get("DUCKDB") ?? "duckdb";
const requestedRows = Deno.env.get("JSIMD_QUERY_ROWS");
const groupCount = positiveInteger(Deno.env.get("JSIMD_QUERY_GROUPS") ?? "2048", "groups");
const outputDirectory = Deno.env.get("JSIMD_DUCKDB_NATIVE_OUTPUT_DIR");
const requestedWorkload = Deno.env.get("JSIMD_QUERY_WORKLOAD");
const workloads: readonly NativeDuckDbWorkloadName[] = requestedWorkload === undefined
  ? ["q6", "q1", "logs", "sparse"]
  : [parseWorkload(requestedWorkload)];
const threads = parseThreads(
  Deno.env.get("JSIMD_DUCKDB_NATIVE_THREADS") ??
    `1,${Math.min(8, navigator.hardwareConcurrency || 1)}`,
);
const version = await duckDbVersion(executable);
const cpu = await detectHostCpu();

for (const name of workloads) {
  const rows = positiveInteger(
    requestedRows ?? (name === "q6" ? "33554432" : "16777216"),
    "rows",
  );
  const workload = nativeDuckDbWorkload(name, rows, groupCount);
  const runs: NativeRun[] = [];
  for (const threadCount of threads) {
    const sessions: NativeSession[] = [];
    for (let repeat = 0; repeat < processRepeats; repeat++) {
      const session = await runNativeDuckDb(executable, workload, threadCount);
      sessions.push(session);
      console.log(JSON.stringify({ workload: name, threads: threadCount, repeat, ...session }));
    }
    runs.push({
      threads: threadCount,
      tableConstructionSamplesMs: sessions.map((session) => session.tableConstructionMs),
      samplesMs: sessions.flatMap((session) => session.samplesMs),
    });
  }
  const result = createBenchmarkResult({
    name: `parallel-columnar-query/duckdb-native-${name}`,
    recordedAt: new Date().toISOString(),
    environment: detectBenchmarkEnvironment({
      runtimeName: "duckdb-native",
      runtimeVersion: version,
      cpu,
      adapter: null,
    }),
    timing: {
      warmups: warmups * processRepeats,
      samples: samples * processRepeats,
      operationsPerSample: 1,
    },
    input: {
      shape: {
        workload: name,
        rows,
        selectivity: workload.selectivity,
        groupCount: workload.groupCount,
      },
      bytes: workload.bytes,
    },
    correctness: {
      passed: true,
      checks: runs.length * processRepeats,
      summary: name === "q6"
        ? "native DuckDB count and sum outputs matched"
        : name === "sparse"
        ? "native DuckDB sparse nullable group states matched"
        : "native DuckDB dense group count, sum, minimum, and maximum outputs matched",
    },
    measurements: runs.map((run) =>
      summarizeBenchmarkSamples(
        `duckdb-native/threads=${run.threads}`,
        "resident",
        run.samplesMs,
      )
    ),
    metrics: Object.fromEntries(
      runs.flatMap((run) => [
        [`configuredThreads_${run.threads}`, run.threads],
        [
          `tableConstructionMedianMs_${run.threads}`,
          median(run.tableConstructionSamplesMs),
        ],
      ]),
    ),
    notes: [
      "Each resident boundary is DuckDB profiler latency for one warm query over a resident in-memory table; CLI startup, CLI result serialization, and table construction are excluded.",
      `Result production is included. Each of ${processRepeats} process repetitions performs one discarded validation query, five profiled warmups, and eleven retained samples.`,
      "Each process repetition constructs a fresh in-memory table in a fresh native DuckDB CLI process.",
    ],
  });
  validateBenchmarkResult(result);
  if (outputDirectory !== undefined) {
    await Deno.mkdir(outputDirectory, { recursive: true });
    const suffix = name === "q6" ? "" : `-${name}`;
    await Deno.writeTextFile(
      `${outputDirectory}/duckdb-native${suffix}.json`,
      JSON.stringify(result, null, 2) + "\n",
    );
  }
  console.log(JSON.stringify(result, null, 2));
}

interface NativeRun {
  readonly threads: number;
  readonly tableConstructionSamplesMs: readonly number[];
  readonly samplesMs: readonly number[];
}

interface NativeSession {
  readonly tableConstructionMs: number;
  readonly samplesMs: readonly number[];
}

async function runNativeDuckDb(
  executable: string,
  workload: NativeDuckDbWorkload,
  threads: number,
): Promise<NativeSession> {
  const repeatedQueries = Array.from(
    { length: warmups + samples },
    () => workload.querySql,
  ).join("\n");
  const script = [
    `SET threads = ${threads};`,
    "PRAGMA enable_profiling='json';",
    workload.setupSql,
    workload.querySql,
    ".output /dev/null",
    repeatedQueries,
  ].join("\n");
  const command = new Deno.Command(executable, {
    args: ["-json", ":memory:"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const process = command.spawn();
  const writer = process.stdin.getWriter();
  await writer.write(new TextEncoder().encode(script));
  await writer.close();
  const output = await process.output();
  const stdout = new TextDecoder().decode(output.stdout).trim();
  const stderr = new TextDecoder().decode(output.stderr);
  if (!output.success) {
    throw new Error(`DuckDB native benchmark failed (${output.code}):\n${stderr}\n${stdout}`);
  }
  const validationRows = JSON.parse(stdout) as readonly Readonly<Record<string, unknown>>[];
  validateNativeDuckDbResult(workload, validationRows);

  const profiles = extractDuckDbProfiles(stderr);
  const expectedProfiles = 2 + warmups + samples;
  if (profiles.length !== expectedProfiles) {
    throw new Error(
      `DuckDB emitted ${profiles.length} profiles, expected ${expectedProfiles}:\n${stderr}`,
    );
  }
  const setup = profiles[0]!;
  if (!setup.queryName.startsWith("CREATE TABLE data AS")) {
    throw new Error(`first DuckDB profile was not table construction: ${setup.queryName}`);
  }
  const queryProfiles = profiles.slice(2);
  if (queryProfiles.some((profile) => profile.queryName !== workload.querySql)) {
    throw new Error("DuckDB profiled an unexpected query");
  }
  return {
    tableConstructionMs: setup.latencyMs,
    samplesMs: queryProfiles.slice(warmups).map((profile) => profile.latencyMs),
  };
}

function median(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError("median requires at least one value");
  return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]!;
}

async function duckDbVersion(executable: string): Promise<string> {
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command(executable, { args: ["--version"] }).output();
  } catch (error) {
    throw new Error(
      `DuckDB CLI was not found at ${executable}; install DuckDB or set DUCKDB`,
      { cause: error },
    );
  }
  if (!output.success) throw new Error(`duckdb --version failed with exit code ${output.code}`);
  const value = new TextDecoder().decode(output.stdout).trim();
  if (value.length === 0) throw new Error("duckdb --version returned an empty version");
  return value;
}

function parseThreads(value: string): number[] {
  const values = [...new Set(value.split(",").map((item) => positiveInteger(item, "threads")))];
  if (values.length === 0) throw new RangeError("at least one thread count is required");
  return values;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new RangeError(`${name} must be positive`);
  return parsed;
}

function parseWorkload(value: string): NativeDuckDbWorkloadName {
  if (value === "q6" || value === "q1" || value === "logs" || value === "sparse") return value;
  throw new Error(`JSIMD_QUERY_WORKLOAD must be q6, q1, logs, or sparse, got ${value}`);
}
