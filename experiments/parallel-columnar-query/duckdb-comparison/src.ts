import * as duckdb from "@duckdb/duckdb-wasm";
import duckdbCoiWorkerUrl from "@duckdb/duckdb-wasm/dist/duckdb-browser-coi.worker.js?url";
import duckdbPthreadWorkerUrl from "@duckdb/duckdb-wasm/dist/duckdb-browser-coi.pthread.worker.js?url";
import duckdbEhWorkerUrl from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import duckdbCoiUrl from "@duckdb/duckdb-wasm/dist/duckdb-coi.wasm?url";
import duckdbEhUrl from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import { ParallelI32Query } from "../mod.ts";

type Mode = "jsimd-single" | "jsimd-workers" | "duckdb-eh" | "duckdb-coi";

interface BenchmarkResult {
  readonly mode: Mode;
  readonly rows: number;
  readonly bytes: number;
  readonly workerCount: number;
  readonly initializationMs: number;
  readonly medianMs: number;
  readonly samplesMs: readonly number[];
  readonly count: number;
  readonly sum: string;
  readonly crossOriginIsolated: boolean;
  readonly userAgent: string;
  readonly duckdbVersion?: string;
  readonly duckdbConfiguredThreads?: number;
}

const parameters = new URLSearchParams(location.search);
const mode = parseMode(parameters.get("mode"));
const rows = parsePositiveInteger(parameters.get("rows") ?? "33554432", "rows");

void run(mode, rows).then(report, reportError);

async function run(mode: Mode, rows: number): Promise<BenchmarkResult> {
  if (!crossOriginIsolated) throw new Error("benchmark requires COOP/COEP isolation");
  switch (mode) {
    case "duckdb-eh":
    case "duckdb-coi":
      return await runDuckDb(mode, rows);
    case "jsimd-single":
    case "jsimd-workers":
      return await runJsimd(mode, rows);
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
    return commonResult(mode, rows, workerCount, initializationMs, samplesMs, aggregate);
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
        ...commonResult(mode, rows, workerCount, initializationMs, samplesMs, aggregate),
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
  rows: number,
  workerCount: number,
  initializationMs: number,
  samplesMs: number[],
  aggregate: { readonly count: number; readonly sum: bigint },
): BenchmarkResult {
  return {
    mode,
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
    body: JSON.stringify({ error: message, mode }),
  });
}
