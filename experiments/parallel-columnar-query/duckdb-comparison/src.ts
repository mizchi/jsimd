import * as duckdb from "@duckdb/duckdb-wasm";
import duckdbCoiWorkerUrl from "@duckdb/duckdb-wasm/dist/duckdb-browser-coi.worker.js?url";
import duckdbPthreadWorkerUrl from "@duckdb/duckdb-wasm/dist/duckdb-browser-coi.pthread.worker.js?url";
import duckdbEhWorkerUrl from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import duckdbCoiUrl from "@duckdb/duckdb-wasm/dist/duckdb-coi.wasm?url";
import duckdbEhUrl from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import { type GroupByAggregate, ParallelI32GroupByU8Query } from "../group_by.ts";
import { ParallelI32Query } from "../mod.ts";

type Mode = "jsimd-single" | "jsimd-workers" | "duckdb-eh" | "duckdb-coi";
type Workload = "q6" | "q1" | "logs";

interface SerializedGroupAggregate extends Omit<GroupByAggregate, "sum"> {
  readonly sum: string;
}

interface BenchmarkResult {
  readonly mode: Mode;
  readonly workload: Workload;
  readonly rows: number;
  readonly bytes: number;
  readonly workerCount: number;
  readonly initializationMs: number;
  readonly medianMs: number;
  readonly samplesMs: readonly number[];
  readonly count?: number;
  readonly sum?: string;
  readonly groups?: readonly SerializedGroupAggregate[];
  readonly crossOriginIsolated: boolean;
  readonly userAgent: string;
  readonly duckdbVersion?: string;
  readonly duckdbConfiguredThreads?: number;
}

const parameters = new URLSearchParams(location.search);
const mode = parseMode(parameters.get("mode"));
const workload = parseWorkload(parameters.get("workload"));
const rows = parsePositiveInteger(parameters.get("rows") ?? "33554432", "rows");

void run(mode, workload, rows).then(report, reportError);

async function run(mode: Mode, workload: Workload, rows: number): Promise<BenchmarkResult> {
  if (!crossOriginIsolated) throw new Error("benchmark requires COOP/COEP isolation");
  switch (mode) {
    case "duckdb-eh":
    case "duckdb-coi":
      return workload === "q6"
        ? await runDuckDb(mode, rows)
        : await runDuckDbGroupBy(mode, workload, rows);
    case "jsimd-single":
    case "jsimd-workers":
      return workload === "q6"
        ? await runJsimd(mode, rows)
        : await runJsimdGroupBy(mode, workload, rows);
  }
}

async function runJsimd(mode: "jsimd-single" | "jsimd-workers", rows: number) {
  const workerCount = mode === "jsimd-workers"
    ? Math.min(8, navigator.hardwareConcurrency || 1)
    : 1;
  const values = new Int32Array(rows);
  for (let index = 0; index < rows; index++) values[index] = (index & 65_535) - 32_768;

  const initializationStart = performance.now();
  const query = await ParallelI32Query.create(values, { workerCount });
  const initializationMs = performance.now() - initializationStart;
  try {
    const execute = mode === "jsimd-single"
      ? () => Promise.resolve(query.scanBetweenSingleThread(-8_192, 8_192))
      : () => query.scanBetween(-8_192, 8_192);
    for (let index = 0; index < 5; index++) validateAggregate(await execute(), rows);
    const samplesMs: number[] = [];
    let aggregate = await execute();
    for (let index = 0; index < 11; index++) {
      const start = performance.now();
      aggregate = await execute();
      samplesMs.push(performance.now() - start);
    }
    validateAggregate(aggregate, rows);
    return commonResult(mode, "q6", rows, workerCount, initializationMs, samplesMs, aggregate);
  } finally {
    await query[Symbol.asyncDispose]();
  }
}

async function runJsimdGroupBy(
  mode: "jsimd-single" | "jsimd-workers",
  workload: "q1" | "logs",
  rows: number,
): Promise<BenchmarkResult> {
  const workerCount = mode === "jsimd-workers"
    ? Math.min(8, navigator.hardwareConcurrency || 1)
    : 1;
  const filter = new Int32Array(rows);
  const values = new Int32Array(rows);
  const groups = new Uint8Array(rows);
  for (let index = 0; index < rows; index++) {
    filter[index] = workload === "q1" ? index % 50 : index;
    values[index] = (index % 20_001) - 10_000;
    groups[index] = index & 7;
  }
  const [lower, upper] = groupBounds(workload, rows);
  const expected = expectedGroupBy(rows, workload);
  const initializationStart = performance.now();
  const query = await ParallelI32GroupByU8Query.create(
    { filter, values, groups },
    { groupCount: 8, workerCount },
  );
  const initializationMs = performance.now() - initializationStart;
  try {
    const execute = mode === "jsimd-single"
      ? () => Promise.resolve(query.aggregateBetweenSingleThread(lower, upper))
      : () => query.aggregateBetween(lower, upper);
    for (let index = 0; index < 5; index++) validateGroups((await execute()).groups, expected);
    const samplesMs: number[] = [];
    let aggregates = (await execute()).groups;
    for (let index = 0; index < 11; index++) {
      const start = performance.now();
      aggregates = (await execute()).groups;
      samplesMs.push(performance.now() - start);
    }
    validateGroups(aggregates, expected);
    return groupResult(mode, workload, rows, workerCount, initializationMs, samplesMs, aggregates);
  } finally {
    await query[Symbol.asyncDispose]();
  }
}

async function runDuckDb(mode: "duckdb-eh" | "duckdb-coi", rows: number) {
  const threaded = mode === "duckdb-coi";
  const workerCount = threaded ? Math.min(8, navigator.hardwareConcurrency || 1) : 1;
  const worker = new Worker(threaded ? duckdbCoiWorkerUrl : duckdbEhWorkerUrl);
  const database = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  const initializationStart = performance.now();
  try {
    await database.instantiate(
      threaded ? duckdbCoiUrl : duckdbEhUrl,
      threaded ? duckdbPthreadWorkerUrl : null,
    );
    const duckdbVersion = await database.getVersion();
    const connection = await database.connect();
    try {
      await connection.query(`SET threads = ${workerCount}`);
      const settings = await connection.query(
        "SELECT current_setting('threads')::INTEGER AS threads",
      );
      const configuredThreads = Number(settings.getChild("threads")?.get(0));
      if (configuredThreads !== workerCount) {
        throw new Error(`DuckDB configured ${configuredThreads} threads, expected ${workerCount}`);
      }
      await connection.query(
        `CREATE TABLE data AS
         SELECT CAST((i & 65535) - 32768 AS INTEGER) AS value
         FROM range(${rows}) AS rows(i)`,
      );
      const initializationMs = performance.now() - initializationStart;
      const sql =
        "SELECT count(*) AS count, sum(value) AS sum FROM data WHERE value >= -8192 AND value < 8192";
      for (let index = 0; index < 5; index++) validateDuckDb(await connection.query(sql), rows);
      const samplesMs: number[] = [];
      let aggregate = { count: 0, sum: 0n };
      for (let index = 0; index < 11; index++) {
        const start = performance.now();
        const table = await connection.query(sql);
        samplesMs.push(performance.now() - start);
        aggregate = validateDuckDb(table, rows);
      }
      return {
        ...commonResult(mode, "q6", rows, workerCount, initializationMs, samplesMs, aggregate),
        duckdbVersion,
        duckdbConfiguredThreads: configuredThreads,
      };
    } finally {
      await connection.close();
    }
  } finally {
    await database.terminate();
  }
}

async function runDuckDbGroupBy(
  mode: "duckdb-eh" | "duckdb-coi",
  workload: "q1" | "logs",
  rows: number,
): Promise<BenchmarkResult> {
  const threaded = mode === "duckdb-coi";
  const workerCount = threaded ? Math.min(8, navigator.hardwareConcurrency || 1) : 1;
  const worker = new Worker(threaded ? duckdbCoiWorkerUrl : duckdbEhWorkerUrl);
  const database = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  const initializationStart = performance.now();
  try {
    await database.instantiate(
      threaded ? duckdbCoiUrl : duckdbEhUrl,
      threaded ? duckdbPthreadWorkerUrl : null,
    );
    const duckdbVersion = await database.getVersion();
    const connection = await database.connect();
    try {
      await connection.query(`SET threads = ${workerCount}`);
      const settings = await connection.query(
        "SELECT current_setting('threads')::INTEGER AS threads",
      );
      const configuredThreads = Number(settings.getChild("threads")?.get(0));
      if (configuredThreads !== workerCount) {
        throw new Error(`DuckDB configured ${configuredThreads} threads, expected ${workerCount}`);
      }
      const filterExpression = workload === "q1" ? "i % 50" : "i";
      await connection.query(
        `CREATE TABLE data AS
         SELECT CAST(${filterExpression} AS INTEGER) AS filter,
                CAST((i % 20001) - 10000 AS INTEGER) AS value,
                CAST(i % 8 AS UTINYINT) AS group_id
         FROM range(${rows}) AS rows(i)`,
      );
      const initializationMs = performance.now() - initializationStart;
      const [lower, upper] = groupBounds(workload, rows);
      const sql =
        "SELECT group_id, count(*) AS count, sum(value) AS sum, min(value) AS min, max(value) AS max " +
        `FROM data WHERE filter >= ${lower} AND filter < ${upper} ` +
        "GROUP BY group_id ORDER BY group_id";
      const expected = expectedGroupBy(rows, workload);
      for (let index = 0; index < 5; index++) {
        validateGroups(readDuckDbGroups(await connection.query(sql)), expected);
      }
      const samplesMs: number[] = [];
      let aggregates: readonly GroupByAggregate[] = [];
      for (let index = 0; index < 11; index++) {
        const start = performance.now();
        aggregates = readDuckDbGroups(await connection.query(sql));
        samplesMs.push(performance.now() - start);
      }
      validateGroups(aggregates, expected);
      return {
        ...groupResult(
          mode,
          workload,
          rows,
          workerCount,
          initializationMs,
          samplesMs,
          aggregates,
        ),
        duckdbVersion,
        duckdbConfiguredThreads: configuredThreads,
      };
    } finally {
      await connection.close();
    }
  } finally {
    await database.terminate();
  }
}

function validateDuckDb(
  table: Awaited<ReturnType<duckdb.AsyncDuckDBConnection["query"]>>,
  rows: number,
) {
  const count = Number(table.getChild("count")?.get(0));
  const sum = BigInt(String(table.getChild("sum")?.get(0)));
  const aggregate = { count, sum };
  validateAggregate(aggregate, rows);
  return aggregate;
}

function readDuckDbGroups(
  table: Awaited<ReturnType<duckdb.AsyncDuckDBConnection["query"]>>,
): GroupByAggregate[] {
  const output: GroupByAggregate[] = [];
  for (let index = 0; index < table.numRows; index++) {
    output.push({
      group: Number(table.getChild("group_id")?.get(index)),
      count: Number(table.getChild("count")?.get(index)),
      sum: BigInt(String(table.getChild("sum")?.get(index))),
      min: Number(table.getChild("min")?.get(index)),
      max: Number(table.getChild("max")?.get(index)),
    });
  }
  return output;
}

function expectedGroupBy(rows: number, workload: "q1" | "logs"): GroupByAggregate[] {
  const counts = new Uint32Array(8);
  const sums = new Float64Array(8);
  const minimums = new Int32Array(8).fill(0x7fff_ffff);
  const maximums = new Int32Array(8).fill(-0x8000_0000);
  const [lower, upper] = groupBounds(workload, rows);
  for (let index = 0; index < rows; index++) {
    const filter = workload === "q1" ? index % 50 : index;
    if (filter < lower || filter >= upper) continue;
    const group = index & 7;
    const value = (index % 20_001) - 10_000;
    counts[group]++;
    sums[group] += value;
    if (value < minimums[group]!) minimums[group] = value;
    if (value > maximums[group]!) maximums[group] = value;
  }
  const output: GroupByAggregate[] = [];
  for (let group = 0; group < counts.length; group++) {
    if (counts[group] === 0) continue;
    output.push({
      group,
      count: counts[group]!,
      sum: BigInt(sums[group]!),
      min: minimums[group]!,
      max: maximums[group]!,
    });
  }
  return output;
}

function groupBounds(workload: "q1" | "logs", rows: number): readonly [number, number] {
  return workload === "q1" ? [0, 25] : [Math.floor(rows * 0.7), Math.floor(rows * 0.8)];
}

function validateGroups(
  actual: readonly GroupByAggregate[],
  expected: readonly GroupByAggregate[],
): void {
  if (actual.length !== expected.length) throw new Error("incorrect group count");
  for (let index = 0; index < expected.length; index++) {
    const left = actual[index]!;
    const right = expected[index]!;
    if (
      left.group !== right.group || left.count !== right.count || left.sum !== right.sum ||
      left.min !== right.min || left.max !== right.max
    ) {
      throw new Error(`incorrect aggregate for group ${right.group}`);
    }
  }
}

function validateAggregate(
  aggregate: { readonly count: number; readonly sum: bigint },
  rows: number,
) {
  if (rows % 65_536 !== 0) return;
  const repetitions = BigInt(rows / 65_536);
  const expectedCount = rows / 4;
  const expectedSum = -8_192n * repetitions;
  if (aggregate.count !== expectedCount || aggregate.sum !== expectedSum) {
    throw new Error(
      `incorrect aggregate: count=${aggregate.count}, sum=${aggregate.sum}; ` +
        `expected count=${expectedCount}, sum=${expectedSum}`,
    );
  }
}

function commonResult(
  mode: Mode,
  workload: Workload,
  rows: number,
  workerCount: number,
  initializationMs: number,
  samplesMs: number[],
  aggregate: { readonly count: number; readonly sum: bigint },
): BenchmarkResult {
  return {
    mode,
    workload,
    rows,
    bytes: rows * Int32Array.BYTES_PER_ELEMENT,
    workerCount,
    initializationMs,
    medianMs: median(samplesMs),
    samplesMs,
    count: aggregate.count,
    sum: String(aggregate.sum),
    crossOriginIsolated,
    userAgent: navigator.userAgent,
  };
}

function groupResult(
  mode: Mode,
  workload: "q1" | "logs",
  rows: number,
  workerCount: number,
  initializationMs: number,
  samplesMs: number[],
  groups: readonly GroupByAggregate[],
): BenchmarkResult {
  return {
    mode,
    workload,
    rows,
    bytes: rows * 9,
    workerCount,
    initializationMs,
    medianMs: median(samplesMs),
    samplesMs,
    groups: groups.map((group) => ({ ...group, sum: String(group.sum) })),
    crossOriginIsolated,
    userAgent: navigator.userAgent,
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function parseMode(value: string | null): Mode {
  if (
    value === "jsimd-single" || value === "jsimd-workers" || value === "duckdb-eh" ||
    value === "duckdb-coi"
  ) return value;
  throw new Error(`invalid benchmark mode: ${value}`);
}

function parseWorkload(value: string | null): Workload {
  if (value === null || value === "q6") return "q6";
  if (value === "q1" || value === "logs") return value;
  throw new Error(`invalid benchmark workload: ${value}`);
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

async function report(result: BenchmarkResult): Promise<void> {
  document.body.textContent = JSON.stringify(result, null, 2);
  await fetch("/__jsimd_result", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(result),
  });
}

async function reportError(error: unknown): Promise<void> {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  document.body.textContent = message;
  await fetch("/__jsimd_result", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ error: message, mode, workload }),
  });
}
