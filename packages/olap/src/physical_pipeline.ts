import { ParallelI32Query, type ScanAggregate } from "./mod.ts";
import type { I32SnapshotPages, SchemaDefinition, SchemaEngine } from "@mizchi/jsimd-columnar";
import { parseAdaptiveI32Snapshot, SharedI32PageEncoding } from "./adaptive_i32_snapshot.ts";

const I32_MIN = -0x8000_0000;
const I32_MAX = 0x7fff_ffff;

export interface I32PageDescriptor {
  readonly rowOffset: number;
  readonly rowCount: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly encoding: I32PhysicalEncoding;
}

export type I32PhysicalEncoding = "raw" | "constant" | "frame-of-reference";

export interface ChunkScanEstimate {
  readonly rows: number;
  readonly pagesTotal: number;
  readonly pagesScanned: number;
  readonly pagesSkipped: number;
  readonly rawRows: number;
  readonly constantRows: number;
  readonly frameOfReferenceRows: number;
  readonly rawPages: number;
  readonly constantPages: number;
  readonly frameOfReferencePages: number;
}

/** Immutable planning metadata for one resident i32 physical column. */
export class ExecutionChunkI32 {
  readonly length: number;
  readonly pageRows: number;
  readonly pages: readonly I32PageDescriptor[];

  private constructor(length: number, pageRows: number, pages: readonly I32PageDescriptor[]) {
    this.length = length;
    this.pageRows = pageRows;
    this.pages = pages;
  }

  static from(values: Int32Array, pageRows: number): ExecutionChunkI32 {
    if (!(values instanceof Int32Array)) throw new TypeError("values must be an Int32Array");
    validatePositiveInteger(pageRows, "pageRows");
    const pages: I32PageDescriptor[] = [];
    for (let rowOffset = 0; rowOffset < values.length; rowOffset += pageRows) {
      const rowCount = Math.min(pageRows, values.length - rowOffset);
      let minimum = values[rowOffset]!;
      let maximum = minimum;
      for (let row = rowOffset + 1; row < rowOffset + rowCount; row++) {
        const value = values[row]!;
        if (value < minimum) minimum = value;
        if (value > maximum) maximum = value;
      }
      pages.push(Object.freeze({ rowOffset, rowCount, minimum, maximum, encoding: "raw" }));
    }
    return new ExecutionChunkI32(values.length, pageRows, Object.freeze(pages));
  }

  static fromPages(
    length: number,
    pageRows: number,
    input: readonly I32PageDescriptor[],
  ): ExecutionChunkI32 {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new RangeError("length must be a non-negative safe integer");
    }
    validatePositiveInteger(pageRows, "pageRows");
    const pages: I32PageDescriptor[] = [];
    let rowOffset = 0;
    for (const page of input) {
      if (
        page.rowOffset !== rowOffset || !Number.isSafeInteger(page.rowCount) ||
        page.rowCount < 1 || page.rowCount > pageRows || page.minimum > page.maximum
      ) throw new RangeError("physical pages must be ordered, contiguous, and valid");
      validateEncoding(page.encoding);
      pages.push(Object.freeze({ ...page }));
      rowOffset += page.rowCount;
    }
    if (rowOffset !== length) throw new RangeError("physical pages must cover length");
    return new ExecutionChunkI32(length, pageRows, Object.freeze(pages));
  }

  static fromSnapshots(column: I32SnapshotPages): ExecutionChunkI32 {
    const pages: I32PageDescriptor[] = [];
    let expectedRowOffset = 0;
    for (const group of column.pages) {
      if (group.rowOffset !== expectedRowOffset) {
        throw new RangeError("snapshot row-group pages must be contiguous and ordered");
      }
      const parsed = parseAdaptiveI32Snapshot(group.bytes);
      if (parsed.length !== group.length) {
        throw new RangeError("encoded snapshot length does not match row-group metadata");
      }
      for (const page of parsed.pages) {
        pages.push(Object.freeze({
          rowOffset: group.rowOffset + page.rowOffset,
          rowCount: page.length,
          minimum: page.minimum,
          maximum: page.maximum,
          encoding: page.encoding === SharedI32PageEncoding.Constant
            ? "constant"
            : page.encoding === SharedI32PageEncoding.FrameOfReference
            ? "frame-of-reference"
            : "raw",
        }));
      }
      expectedRowOffset += group.length;
    }
    if (expectedRowOffset !== column.rowCount) {
      throw new RangeError("snapshot row-group pages do not cover rowCount");
    }
    return new ExecutionChunkI32(column.rowCount, 256, Object.freeze(pages));
  }

  estimateBetween(minimum: number, maximum: number): ChunkScanEstimate {
    const lower = validateI32(minimum, "minimum");
    const upper = validateI32(maximum, "maximum");
    let rows = 0;
    let pagesScanned = 0;
    let rawRows = 0;
    let constantRows = 0;
    let frameOfReferenceRows = 0;
    let rawPages = 0;
    let constantPages = 0;
    let frameOfReferencePages = 0;
    if (lower < upper) {
      for (const page of this.pages) {
        if (upper <= page.minimum || lower > page.maximum) continue;
        pagesScanned++;
        rows += page.rowCount;
        if (page.encoding === "raw") {
          rawRows += page.rowCount;
          rawPages++;
        } else if (page.encoding === "constant") {
          constantRows += page.rowCount;
          constantPages++;
        } else {
          frameOfReferenceRows += page.rowCount;
          frameOfReferencePages++;
        }
      }
    }
    return Object.freeze({
      rows,
      pagesTotal: this.pages.length,
      pagesScanned,
      pagesSkipped: this.pages.length - pagesScanned,
      rawRows,
      constantRows,
      frameOfReferenceRows,
      rawPages,
      constantPages,
      frameOfReferencePages,
    });
  }
}

export interface PhysicalExecutionCostModel {
  /** JS descriptor traversal and JS-to-Wasm call cost per surviving physical page. */
  readonly directPageOverheadMs: number;
  /** Worker-only atomic page claim and descriptor coordination cost per surviving page. */
  readonly workerPageOverheadMs: number;
  readonly rawRowCostMs: number;
  readonly constantRowCostMs: number;
  readonly frameOfReferenceRowCostMs: number;
  /** Fixed cost of publishing one operation to an already-running Worker pool. */
  readonly workerDispatchMs: number;
  /** Parallel efficiency after page ownership imbalance, in the range (0, 1]. */
  readonly parallelEfficiency: number;
}

export type PhysicalExecutionPreference = "auto" | "direct" | "workers";
export type PhysicalExecution = Exclude<PhysicalExecutionPreference, "auto">;

export interface PhysicalExecutionPlan extends ChunkScanEstimate {
  readonly execution: PhysicalExecution;
  readonly requested: PhysicalExecutionPreference;
  readonly workerCount: number;
  readonly activeWorkers: number;
  readonly estimatedDirectMs: number;
  readonly estimatedWorkerMs: number;
  readonly reason: string;
}

export const DENO_I32_COUNT_SUM_COST_MODEL: PhysicalExecutionCostModel = Object.freeze({
  directPageOverheadMs: 0.000056,
  workerPageOverheadMs: 0,
  rawRowCostMs: 0.000000145,
  constantRowCostMs: 0,
  frameOfReferenceRowCostMs: 0.00000123,
  workerDispatchMs: 2.2,
  parallelEfficiency: 0.7,
});

/** Apple M5 / headless Chromium 152 resident raw and adaptive count+sum calibration. */
export const CHROMIUM_I32_COUNT_SUM_COST_MODEL: PhysicalExecutionCostModel = Object.freeze({
  directPageOverheadMs: 0.000056,
  workerPageOverheadMs: 0.00042,
  rawRowCostMs: 0.000000145,
  constantRowCostMs: 0,
  frameOfReferenceRowCostMs: 0.00000123,
  workerDispatchMs: 0.07,
  parallelEfficiency: 0.7,
});

/** Pure cost comparison; it never reads or mutates the resident execution state. */
export class PhysicalExecutionPlanner {
  readonly costModel: PhysicalExecutionCostModel;

  constructor(costModel: PhysicalExecutionCostModel = DENO_I32_COUNT_SUM_COST_MODEL) {
    validateNonNegativeFinite(costModel.directPageOverheadMs, "directPageOverheadMs");
    validateNonNegativeFinite(costModel.workerPageOverheadMs, "workerPageOverheadMs");
    validateNonNegativeFinite(costModel.rawRowCostMs, "rawRowCostMs");
    validateNonNegativeFinite(costModel.constantRowCostMs, "constantRowCostMs");
    validateNonNegativeFinite(
      costModel.frameOfReferenceRowCostMs,
      "frameOfReferenceRowCostMs",
    );
    validateNonNegativeFinite(costModel.workerDispatchMs, "workerDispatchMs");
    if (
      !Number.isFinite(costModel.parallelEfficiency) || costModel.parallelEfficiency <= 0 ||
      costModel.parallelEfficiency > 1
    ) {
      throw new RangeError("parallelEfficiency must be greater than zero and at most one");
    }
    this.costModel = Object.freeze({ ...costModel });
  }

  plan(
    estimate: ChunkScanEstimate,
    workerCount: number,
    requested: PhysicalExecutionPreference = "auto",
  ): PhysicalExecutionPlan {
    validateEstimate(estimate);
    validatePositiveInteger(workerCount, "workerCount");
    validatePreference(requested);
    const activeWorkers = Math.max(1, Math.min(workerCount, estimate.pagesScanned));
    const estimatedDirectMs = estimate.pagesScanned * this.costModel.directPageOverheadMs +
      estimate.rawRows * this.costModel.rawRowCostMs +
      estimate.constantRows * this.costModel.constantRowCostMs +
      estimate.frameOfReferenceRows * this.costModel.frameOfReferenceRowCostMs;
    const estimatedWorkerMs = this.costModel.workerDispatchMs +
      (estimatedDirectMs + estimate.pagesScanned * this.costModel.workerPageOverheadMs) /
        (activeWorkers * this.costModel.parallelEfficiency);
    const execution = requested === "auto"
      ? estimatedWorkerMs < estimatedDirectMs ? "workers" : "direct"
      : requested;
    const reason = requested === "auto"
      ? execution === "workers"
        ? "estimated parallel page work repays persistent-Worker dispatch"
        : "estimated surviving page work is cheaper without Worker dispatch"
      : `execution was forced to ${requested}`;
    return Object.freeze({
      ...estimate,
      execution,
      requested,
      workerCount,
      activeWorkers,
      estimatedDirectMs,
      estimatedWorkerMs,
      reason,
    });
  }
}

export interface I32AggregatePipelineOptions {
  readonly workerCount?: number;
  readonly pageRows?: number;
  readonly costModel?: PhysicalExecutionCostModel;
}

export interface PhysicalAggregateResult extends ScanAggregate {
  readonly plan: PhysicalExecutionPlan;
}

/** Stateful resident executor behind the immutable chunk and pure planner contracts. */
export class I32AggregatePipeline implements AsyncDisposable {
  readonly workerCount: number;
  readonly pageRows: number;
  readonly planner: PhysicalExecutionPlanner;
  #chunk: ExecutionChunkI32;
  readonly #query: ParallelI32Query;
  #disposed = false;

  private constructor(
    query: ParallelI32Query,
    chunk: ExecutionChunkI32,
    planner: PhysicalExecutionPlanner,
  ) {
    this.#query = query;
    this.#chunk = chunk;
    this.planner = planner;
    this.workerCount = query.workerCount;
    this.pageRows = query.pageRows;
  }

  static async create(
    values: Int32Array,
    options: I32AggregatePipelineOptions = {},
  ): Promise<I32AggregatePipeline> {
    if (!(values instanceof Int32Array)) throw new TypeError("values must be an Int32Array");
    const pageRows = options.pageRows ?? 65_536;
    const chunk = ExecutionChunkI32.from(values, pageRows);
    const planner = new PhysicalExecutionPlanner(options.costModel);
    const query = await ParallelI32Query.create(values, {
      workerCount: options.workerCount,
      pageRows,
    });
    return new I32AggregatePipeline(query, chunk, planner);
  }

  static async createFromSchema<
    Schema extends SchemaDefinition,
    Name extends keyof Schema["tables"] & string,
    Column extends keyof Schema["tables"][Name]["columns"] & string,
  >(
    engine: SchemaEngine<Schema>,
    table: Name,
    column: Column,
    options: Omit<I32AggregatePipelineOptions, "pageRows"> = {},
  ): Promise<I32AggregatePipeline> {
    const snapshots = await engine.readI32SnapshotPages(table, column);
    const chunk = ExecutionChunkI32.fromSnapshots(snapshots);
    const planner = new PhysicalExecutionPlanner(options.costModel);
    const query = await ParallelI32Query.createFromSnapshots(snapshots, {
      workerCount: options.workerCount,
    });
    return new I32AggregatePipeline(query, chunk, planner);
  }

  get chunk(): ExecutionChunkI32 {
    this.#assertAlive();
    return this.#chunk;
  }

  get generation(): number {
    this.#assertAlive();
    return this.#query.generation;
  }

  get persistedGeneration(): string | undefined {
    this.#assertAlive();
    return this.#query.persistedGeneration;
  }

  get encodedPayloadBytes(): number {
    this.#assertAlive();
    return this.#query.encodedPayloadBytes;
  }

  replace(values: Int32Array): number {
    this.#assertAlive();
    if (this.#query.persistedGeneration !== undefined) {
      throw new Error("schema-backed pipelines must be recreated from a published generation");
    }
    if (!(values instanceof Int32Array)) throw new TypeError("values must be an Int32Array");
    if (values.length !== this.#chunk.length) {
      throw new RangeError("replacement length must match the existing column");
    }
    const nextChunk = ExecutionChunkI32.from(values, this.pageRows);
    const generation = this.#query.replace(values);
    this.#chunk = nextChunk;
    return generation;
  }

  /** Requests cancellation of an active Worker scan at its next page boundary. */
  cancelCurrent(): boolean {
    return this.#query.cancelCurrent();
  }

  /** Replaces the persistent Worker pool without rebuilding the resident snapshot. */
  async restartWorkers(): Promise<void> {
    this.#assertAlive();
    await this.#query.restartWorkers();
  }

  async aggregateBetween(
    minimum: number,
    maximum: number,
    options: { readonly execution?: PhysicalExecutionPreference } = {},
  ): Promise<PhysicalAggregateResult> {
    this.#assertAlive();
    const requested = options.execution ?? "auto";
    validatePreference(requested);
    const plan = this.planner.plan(
      this.#chunk.estimateBetween(minimum, maximum),
      this.workerCount,
      requested,
    );
    const aggregate = plan.execution === "workers"
      ? await this.#query.scanBetween(minimum, maximum)
      : this.#query.scanBetweenSingleThread(minimum, maximum);
    return Object.freeze({ ...aggregate, plan });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.#query[Symbol.asyncDispose]();
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("I32AggregatePipeline has been disposed");
  }
}

function validateEstimate(estimate: ChunkScanEstimate): void {
  for (const [name, value] of Object.entries(estimate)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer`);
    }
  }
  if (
    estimate.pagesScanned + estimate.pagesSkipped !== estimate.pagesTotal ||
    estimate.pagesScanned > estimate.pagesTotal ||
    estimate.rawRows + estimate.constantRows + estimate.frameOfReferenceRows !== estimate.rows ||
    estimate.rawPages + estimate.constantPages + estimate.frameOfReferencePages !==
      estimate.pagesScanned
  ) throw new RangeError("invalid page estimate");
}

function validateEncoding(value: string): asserts value is I32PhysicalEncoding {
  if (value !== "raw" && value !== "constant" && value !== "frame-of-reference") {
    throw new RangeError("physical page encoding is invalid");
  }
}

function validatePreference(value: string): asserts value is PhysicalExecutionPreference {
  if (value !== "auto" && value !== "direct" && value !== "workers") {
    throw new RangeError("execution must be auto, direct, or workers");
  }
}

function validateI32(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < I32_MIN || value > I32_MAX) {
    throw new RangeError(`${name} must be a signed 32-bit integer`);
  }
  return value;
}

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function validateNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
}
