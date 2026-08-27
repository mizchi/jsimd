import { BlockedVectorArray } from "../../../src/blocked-vector-array/mod.ts";
import { ParallelHybridVectorIndex } from "../../parallel-hybrid-query/parallel_index.ts";
import { assertSameTopK, firstBatchCrossover, makeQueries, makeValues } from "../browser_matrix.ts";
import { WebGpuVectorSearch } from "../gpu_index.ts";
import {
  type BenchmarkMeasurement,
  measureEndToEnd,
  measureResident,
} from "../../../tools/benchmark/measure.ts";
import {
  type BenchmarkAdapter,
  type BenchmarkResultV1,
  createBenchmarkResult,
  detectBenchmarkEnvironment,
} from "../../../tools/benchmark/result.ts";

interface MatrixBatchMeasurement {
  readonly queryCount: number;
  readonly wasmMedianMs: number;
  readonly webgpuMedianMs: number;
  readonly webgpuSingleSubmissionMedianMs: number;
}

interface MatrixRowMeasurement {
  readonly rows: number;
  readonly batches: readonly MatrixBatchMeasurement[];
}

export async function benchmarkWebGpuMatrix(options: {
  readonly rows: readonly number[];
  readonly dimensions: number;
  readonly batchSizes: readonly number[];
  readonly inFlightCounts: readonly number[];
  readonly workerCount: number;
  readonly k: number;
  readonly warmups: number;
  readonly samples: number;
  readonly cpu: string;
}): Promise<BenchmarkResultV1> {
  const rows = positiveIntegers(options.rows, "rows");
  const batchSizes = positiveIntegers(options.batchSizes, "batchSizes");
  const inFlightCounts = positiveIntegers(options.inFlightCounts, "inFlightCounts");
  const workerCount = positiveInteger(options.workerCount, "workerCount");
  const dimensions = positiveInteger(options.dimensions, "dimensions");
  const k = positiveInteger(options.k, "k");
  const warmups = nonNegativeInteger(options.warmups, "warmups");
  const samples = positiveInteger(options.samples, "samples");
  const maxRows = Math.max(...rows);
  if (Math.min(...rows) < k) throw new RangeError("every row count must cover k");
  const maxBatchSize = Math.max(...batchSizes);
  const inFlightSlots = Math.max(...inFlightCounts);
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("WebGPU adapter is unavailable in Chromium");
  const pipelineStart = performance.now();
  await using search = await WebGpuVectorSearch.create({
    adapter,
    maxK: k,
    maxBatchSize,
    inFlightSlots,
  });
  const pipelineInitMs = performance.now() - pipelineStart;
  const allValues = makeValues(maxRows, dimensions);
  const timing = { warmups, samples, operationsPerSample: 1 };
  const measurements: BenchmarkMeasurement[] = [];
  const matrix: MatrixRowMeasurement[] = [];
  let correctnessChecks = 0;

  for (const rowCount of rows) {
    await progress({ phase: "row-start", rows: rowCount });
    const values = allValues.subarray(0, rowCount * dimensions);
    using wasm = BlockedVectorArray.from(values, rowCount, dimensions);
    using gpu = search.upload(values, rowCount, dimensions);
    await progress({ phase: "workers-start", rows: rowCount, workerCount });
    await using workers = await ParallelHybridVectorIndex.create(
      new Int32Array(rowCount),
      values,
      dimensions,
      {
        workerCount,
        maxK: k,
      },
    );
    await progress({ phase: "workers-ready", rows: rowCount, workerCount });
    const batches: MatrixBatchMeasurement[] = [];

    for (const queryCount of batchSizes) {
      await progress({ phase: "batch-start", rows: rowCount, queryCount });
      const queries = makeQueries(values, rowCount, dimensions, queryCount);
      const expectedIds = new Uint32Array(queryCount * k);
      const expectedDistances = new Float32Array(queryCount * k);
      const runWasm = () => {
        for (let queryIndex = 0; queryIndex < queryCount; queryIndex++) {
          wasm.topKInto(
            queries.subarray(queryIndex * dimensions, (queryIndex + 1) * dimensions),
            expectedIds.subarray(queryIndex * k, (queryIndex + 1) * k),
            expectedDistances.subarray(queryIndex * k, (queryIndex + 1) * k),
          );
        }
      };
      runWasm();
      const initial = await gpu.topKBatch(queries, queryCount, k);
      assertSameTopK(expectedIds, expectedDistances, initial.ids, initial.distances);
      correctnessChecks++;
      const runWorkers = async () => {
        for (let queryIndex = 0; queryIndex < queryCount; queryIndex++) {
          const actual = await workers.searchBetween(
            queries.subarray(queryIndex * dimensions, (queryIndex + 1) * dimensions),
            -1,
            1,
            { k, plan: "filter-first", selector: "wasm" },
          );
          assertSameTopK(
            expectedIds.subarray(queryIndex * k, (queryIndex + 1) * k),
            expectedDistances.subarray(queryIndex * k, (queryIndex + 1) * k),
            actual.ids,
            actual.distances,
          );
          correctnessChecks++;
        }
      };
      await runWorkers();

      const wasmMeasurement = await measureResident(
        `wasm-resident/rows=${rowCount}/queries=${queryCount}`,
        timing,
        runWasm,
      );
      const gpuMeasurement = await measureResident(
        `webgpu-resident/rows=${rowCount}/queries=${queryCount}`,
        timing,
        async () => {
          const actual = await gpu.topKBatch(queries, queryCount, k);
          assertSameTopK(expectedIds, expectedDistances, actual.ids, actual.distances);
          correctnessChecks++;
        },
      );
      const singleSubmissionMeasurement = await measureResident(
        `webgpu-single-submission/rows=${rowCount}/queries=${queryCount}`,
        timing,
        async () => {
          const actual = await gpu.topKBatchSingleSubmission(queries, queryCount, k);
          assertSameTopK(expectedIds, expectedDistances, actual.ids, actual.distances);
          correctnessChecks++;
        },
      );
      const workerMeasurement = await measureResident(
        `wasm-workers-resident/rows=${rowCount}/queries=${queryCount}/workers=${workerCount}`,
        timing,
        runWorkers,
      );
      measurements.push(
        wasmMeasurement,
        workerMeasurement,
        gpuMeasurement,
        singleSubmissionMeasurement,
      );
      batches.push({
        queryCount,
        wasmMedianMs: wasmMeasurement.medianMs,
        webgpuMedianMs: gpuMeasurement.medianMs,
        webgpuSingleSubmissionMedianMs: singleSubmissionMeasurement.medianMs,
      });

      for (const submissionCount of inFlightCounts) {
        if (submissionCount === 1) continue;
        const runWasmSubmissions = () => {
          for (let submission = 0; submission < submissionCount; submission++) runWasm();
        };
        const wasmSubmissions = await measureResident(
          `wasm-resident/rows=${rowCount}/queries=${queryCount}/submissions=${submissionCount}`,
          timing,
          runWasmSubmissions,
        );
        const gpuRing = await measureResident(
          `webgpu-ring/rows=${rowCount}/queries=${queryCount}/submissions=${submissionCount}`,
          timing,
          async () => {
            const results = await Promise.all(
              Array.from(
                { length: submissionCount },
                () => gpu.topKBatch(queries, queryCount, k),
              ),
            );
            for (const actual of results) {
              assertSameTopK(expectedIds, expectedDistances, actual.ids, actual.distances);
              correctnessChecks++;
            }
          },
        );
        measurements.push(wasmSubmissions, gpuRing);
      }
      await progress({ phase: "batch-complete", rows: rowCount, queryCount });
    }

    const oneQuery = makeQueries(values, rowCount, dimensions, 1);
    const expectedIds = new Uint32Array(k);
    const expectedDistances = new Float32Array(k);
    wasm.topKInto(oneQuery, expectedIds, expectedDistances);
    measurements.push(
      await measureEndToEnd(
        `webgpu-upload-query/rows=${rowCount}/queries=1`,
        timing,
        async () => {
          using oneShot = search.upload(values, rowCount, dimensions);
          const actual = await oneShot.topK(oneQuery, k);
          assertSameTopK(expectedIds, expectedDistances, actual.ids, actual.distances);
          correctnessChecks++;
        },
      ),
    );
    matrix.push({ rows: rowCount, batches });
    await progress({ phase: "row-complete", rows: rowCount });
  }

  const crossover = Object.fromEntries(batchSizes.map((queryCount) => {
    const rowCount = firstBatchCrossover(matrix, queryCount);
    return [`crossoverRowsQ${queryCount}`, rowCount ?? "none"];
  }));
  const singleSubmissionCrossover = Object.fromEntries(batchSizes.map((queryCount) => {
    const rowCount = firstBatchCrossover(
      matrix.map((measurement) => ({
        rows: measurement.rows,
        batches: measurement.batches.map((batch) => ({
          ...batch,
          webgpuMedianMs: batch.webgpuSingleSubmissionMedianMs,
        })),
      })),
      queryCount,
    );
    return [`singleSubmissionCrossoverRowsQ${queryCount}`, rowCount ?? "none"];
  }));
  return createBenchmarkResult({
    name: "webgpu-vector-search/chromium-crossover-matrix",
    recordedAt: new Date().toISOString(),
    environment: detectBenchmarkEnvironment({
      runtimeName: "chromium",
      runtimeVersion: browserVersion(navigator.userAgent),
      cpu: options.cpu,
      adapter: benchmarkAdapter(search.adapterInfo),
      crossOriginIsolated: (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated,
    }),
    timing,
    input: {
      shape: { rows, dimensions, batchSizes, inFlightCounts, workerCount, k },
      bytes: maxRows * dimensions * Float32Array.BYTES_PER_ELEMENT,
    },
    correctness: {
      passed: true,
      checks: correctnessChecks,
      summary: "every Chromium WebGPU top-k result matched BlockedVectorArray ids and distances",
    },
    measurements,
    metrics: {
      pipelineInitMs,
      maxInputMiB: maxRows * dimensions * Float32Array.BYTES_PER_ELEMENT / 1024 / 1024,
      inFlightSlots,
      workerCount,
      ...crossover,
      ...singleSubmissionCrossover,
    },
    notes: [
      "Resident measurements include query upload, GPU scheduling, exact top-k, final readback, and typed-array materialization.",
      "Upload-query measurements additionally include row-to-dimension-major conversion and GPU index upload.",
      "Wasm measurements execute the same query batch sequentially against a resident BlockedVectorArray.",
      "Ring measurements submit independent batches concurrently into separate query, scratch, and readback slots on one resident index.",
      "Persistent Worker measurements shard one immutable PDX64 index in shared WebAssembly memory and execute each query in the batch sequentially.",
      "Single-submission measurements encode every reduction pass and final readback copy into one GPU command buffer.",
    ],
  });
}

function benchmarkAdapter(info: GPUAdapterInfo): BenchmarkAdapter {
  return Object.fromEntries(
    Object.entries({
      vendor: info.vendor,
      architecture: info.architecture,
      device: info.device,
      description: info.description,
    }).filter(([, value]) => value.length > 0),
  );
}

function browserVersion(userAgent: string): string {
  return /(?:Chrome|Chromium)\/([^ ]+)/.exec(userAgent)?.[1] ?? userAgent;
}

function positiveIntegers(values: readonly number[], name: string): number[] {
  if (values.length === 0) throw new RangeError(`${name} must not be empty`);
  return values.map((value) => positiveInteger(value, name));
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return value;
}

Object.assign(globalThis, { benchmarkWebGpuMatrix });

const parameters = new URLSearchParams(location.search);
if (parameters.get("benchmark") === "webgpu") {
  benchmarkWebGpuMatrix({
    rows: commaSeparatedIntegers(parameters.get("rows") ?? "1024,4096,16384,65536,262144"),
    dimensions: Number(parameters.get("dimensions") ?? 128),
    batchSizes: commaSeparatedIntegers(parameters.get("batches") ?? "1,4,16,64,128"),
    inFlightCounts: commaSeparatedIntegers(parameters.get("inFlight") ?? "1,2,3"),
    workerCount: Number(parameters.get("workers") ?? 4),
    k: Number(parameters.get("k") ?? 10),
    warmups: Number(parameters.get("warmups") ?? 5),
    samples: Number(parameters.get("samples") ?? 15),
    cpu: parameters.get("cpu") ?? "unavailable",
  }).then(postResult, postError);
}

function commaSeparatedIntegers(value: string): number[] {
  return value.split(",").map(Number);
}

async function postResult(result: BenchmarkResultV1): Promise<void> {
  await fetch("/__jsimd_result", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(result),
  });
}

async function postError(error: unknown): Promise<void> {
  await fetch("/__jsimd_result", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ error: error instanceof Error ? error.stack : String(error) }),
  });
}

async function progress(value: unknown): Promise<void> {
  await fetch("/__jsimd_progress", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}
