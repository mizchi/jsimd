import { type GroupByColumns, type GroupByResult, ParallelI32GroupByU8Query } from "./group_by.ts";
import {
  ExecutionChunkI32,
  type PhysicalExecutionCostModel,
  type PhysicalExecutionPlan,
  PhysicalExecutionPlanner,
  type PhysicalExecutionPreference,
} from "./physical_pipeline.ts";

/** Apple M5 / Deno 2.6.4 resident low-cardinality group-by calibration. */
export const DENO_I32_GROUP_BY_U8_COST_MODEL: PhysicalExecutionCostModel = Object.freeze({
  directPageOverheadMs: 0,
  workerPageOverheadMs: 0,
  rawRowCostMs: 0.000002,
  constantRowCostMs: 0.000002,
  frameOfReferenceRowCostMs: 0.000002,
  workerDispatchMs: 2.1,
  parallelEfficiency: 0.7,
});

export interface I32GroupByU8PipelineOptions {
  readonly groupCount?: number;
  readonly workerCount?: number;
  readonly pageRows?: number;
  readonly costModel?: PhysicalExecutionCostModel;
}

export interface PhysicalGroupByResult extends GroupByResult {
  readonly plan: PhysicalExecutionPlan;
}

/** Immutable low-cardinality group-by with an operator-specific physical execution plan. */
export class I32GroupByU8Pipeline implements AsyncDisposable {
  readonly workerCount: number;
  readonly pageRows: number;
  readonly groupCount: number;
  readonly planner: PhysicalExecutionPlanner;
  readonly chunk: ExecutionChunkI32;
  readonly #query: ParallelI32GroupByU8Query;
  #disposed = false;

  private constructor(
    query: ParallelI32GroupByU8Query,
    chunk: ExecutionChunkI32,
    planner: PhysicalExecutionPlanner,
  ) {
    this.#query = query;
    this.chunk = chunk;
    this.planner = planner;
    this.workerCount = query.workerCount;
    this.pageRows = query.pageRows;
    this.groupCount = query.groupCount;
  }

  static async create(
    columns: GroupByColumns,
    options: I32GroupByU8PipelineOptions = {},
  ): Promise<I32GroupByU8Pipeline> {
    const pageRows = options.pageRows ?? 65_536;
    const chunk = ExecutionChunkI32.from(columns.filter, pageRows);
    const planner = new PhysicalExecutionPlanner(
      options.costModel ?? DENO_I32_GROUP_BY_U8_COST_MODEL,
    );
    const query = await ParallelI32GroupByU8Query.create(columns, {
      groupCount: options.groupCount,
      workerCount: options.workerCount,
      pageRows,
    });
    return new I32GroupByU8Pipeline(query, chunk, planner);
  }

  async aggregateBetween(
    minimum: number,
    maximum: number,
    options: { readonly execution?: PhysicalExecutionPreference } = {},
  ): Promise<PhysicalGroupByResult> {
    this.#assertAlive();
    const plan = this.planner.plan(
      this.chunk.estimateBetween(minimum, maximum),
      this.workerCount,
      options.execution ?? "auto",
    );
    const aggregate = plan.execution === "workers"
      ? await this.#query.aggregateBetween(minimum, maximum)
      : this.#query.aggregateBetweenSingleThread(minimum, maximum);
    return Object.freeze({ ...aggregate, plan });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.#query[Symbol.asyncDispose]();
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("I32GroupByU8Pipeline has been disposed");
  }
}
