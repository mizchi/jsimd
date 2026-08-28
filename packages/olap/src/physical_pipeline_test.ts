import {
  CHROMIUM_I32_COUNT_SUM_COST_MODEL,
  ExecutionChunkI32,
  I32AggregatePipeline,
  PhysicalExecutionPlanner,
} from "./physical_pipeline.ts";
import { groupByBetweenReference } from "./group_by.ts";
import {
  DENO_I32_GROUP_BY_U8_COST_MODEL,
  I32GroupByU8Pipeline,
} from "./group_physical_pipeline.ts";
import { scanBetweenReference } from "./mod.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("PhysicalExecutionPlanner compares surviving-page work with dispatch cost", () => {
  const chunk = ExecutionChunkI32.from(
    Int32Array.from({ length: 1_024 }, (_, index) => index),
    128,
  );
  const planner = new PhysicalExecutionPlanner({
    directPageOverheadMs: 0,
    workerPageOverheadMs: 0,
    rawRowCostMs: 1 / 128,
    constantRowCostMs: 1 / 128,
    frameOfReferenceRowCostMs: 1 / 128,
    workerDispatchMs: 2,
    parallelEfficiency: 1,
  });

  const selective = planner.plan(chunk.estimateBetween(300, 340), 4);
  assert(selective.execution === "direct", "one surviving page stays direct");
  assert(selective.pagesScanned === 1 && selective.pagesSkipped === 7, "ZoneMap estimate");
  assert(selective.estimatedDirectMs === 1, "direct estimate");

  const full = planner.plan(chunk.estimateBetween(0, 1_024), 4);
  assert(full.execution === "workers", "large surviving work uses Workers");
  assert(full.activeWorkers === 4, "planner caps active Workers by useful pages");
  assert(full.estimatedWorkerMs === 4, "dispatch plus parallel page work");

  const calibrated = new PhysicalExecutionPlanner();
  assert(
    calibrated.plan(
      {
        rows: 128 * 65_536,
        pagesTotal: 512,
        pagesScanned: 128,
        pagesSkipped: 384,
        rawRows: 128 * 65_536,
        constantRows: 0,
        frameOfReferenceRows: 0,
        rawPages: 128,
        constantPages: 0,
        frameOfReferencePages: 0,
      },
      8,
    )
      .execution === "direct",
    "recorded 128-page count+sum remains direct",
  );
  assert(
    calibrated.plan({
      rows: 512 * 65_536,
      pagesTotal: 512,
      pagesScanned: 512,
      pagesSkipped: 0,
      rawRows: 512 * 65_536,
      constantRows: 0,
      frameOfReferenceRows: 0,
      rawPages: 512,
      constantPages: 0,
      frameOfReferencePages: 0,
    }, 8)
      .execution === "workers",
    "recorded 512-page count+sum uses Workers",
  );
});

Deno.test("I32AggregatePipeline keeps direct and Worker result contracts identical", async () => {
  const values = Int32Array.from({ length: 1_024 }, (_, index) => index);
  await using pipeline = await I32AggregatePipeline.create(values, {
    workerCount: 4,
    pageRows: 128,
    costModel: {
      directPageOverheadMs: 0,
      workerPageOverheadMs: 0,
      rawRowCostMs: 1 / 128,
      constantRowCostMs: 1 / 128,
      frameOfReferenceRowCostMs: 1 / 128,
      workerDispatchMs: 2,
      parallelEfficiency: 1,
    },
  });

  const selective = await pipeline.aggregateBetween(300, 340);
  const expectedSelective = scanBetweenReference(values, 300, 340);
  assert(selective.plan.execution === "direct", "auto chooses direct");
  assert(selective.count === expectedSelective.count, "direct count");
  assert(selective.sum === expectedSelective.sum, "direct sum");

  const full = await pipeline.aggregateBetween(0, 1_024);
  const expectedFull = scanBetweenReference(values, 0, 1_024);
  assert(full.plan.execution === "workers", "auto chooses Workers");
  assert(full.count === expectedFull.count, "Worker count");
  assert(full.sum === expectedFull.sum, "Worker sum");

  const forced = await pipeline.aggregateBetween(300, 340, { execution: "workers" });
  assert(forced.plan.execution === "workers", "explicit execution overrides the planner");
  assert(
    forced.count === expectedSelective.count && forced.sum === expectedSelective.sum,
    "forced",
  );
});

Deno.test("I32AggregatePipeline replacement updates data and planning metadata", async () => {
  await using pipeline = await I32AggregatePipeline.create(
    Int32Array.from({ length: 512 }, (_, index) => index),
    {
      workerCount: 2,
      pageRows: 128,
      costModel: {
        directPageOverheadMs: 0,
        workerPageOverheadMs: 0,
        rawRowCostMs: 1 / 128,
        constantRowCostMs: 1 / 128,
        frameOfReferenceRowCostMs: 1 / 128,
        workerDispatchMs: 1,
        parallelEfficiency: 1,
      },
    },
  );
  const generation = pipeline.generation;
  const next = new Int32Array(512).fill(7);
  const replacement = pipeline.replace(next);
  assert(replacement > generation && pipeline.generation === replacement, "generation advances");
  const result = await pipeline.aggregateBetween(7, 8);
  assert(result.count === 512 && result.sum === 3_584n, "replacement values are queried");
  assert(result.plan.pagesScanned === 4 && result.plan.pagesSkipped === 0, "metadata replaced");
});

Deno.test("physical pipeline validates cost, shape, override, and lifetime contracts", async () => {
  let threw = false;
  try {
    new PhysicalExecutionPlanner({
      directPageOverheadMs: -1,
      workerPageOverheadMs: 0,
      rawRowCostMs: 1,
      constantRowCostMs: 1,
      frameOfReferenceRowCostMs: 1,
      workerDispatchMs: 1,
      parallelEfficiency: 1,
    });
  } catch (error) {
    threw = error instanceof RangeError;
  }
  assert(threw, "invalid cost model rejects");

  const pipeline = await I32AggregatePipeline.create(new Int32Array([1, 2, 3]), {
    workerCount: 1,
    pageRows: 4,
  });
  threw = false;
  try {
    await pipeline.aggregateBetween(0, 4, { execution: "invalid" as "auto" });
  } catch (error) {
    threw = error instanceof RangeError;
  }
  assert(threw, "invalid override rejects");
  await pipeline[Symbol.asyncDispose]();
  threw = false;
  try {
    await pipeline.aggregateBetween(0, 4);
  } catch (error) {
    threw = error instanceof Error && error.message.includes("disposed");
  }
  assert(threw, "disposed pipeline rejects");
});

Deno.test("PhysicalExecutionPlanner prices page overhead and adaptive row encodings separately", () => {
  const chunk = ExecutionChunkI32.fromPages(768, 256, [
    { rowOffset: 0, rowCount: 256, minimum: 0, maximum: 0, encoding: "constant" },
    {
      rowOffset: 256,
      rowCount: 256,
      minimum: 10,
      maximum: 265,
      encoding: "frame-of-reference",
    },
    { rowOffset: 512, rowCount: 256, minimum: 1_000, maximum: 100_000, encoding: "raw" },
  ]);
  const planner = new PhysicalExecutionPlanner({
    directPageOverheadMs: 1,
    workerPageOverheadMs: 0,
    rawRowCostMs: 0.03,
    constantRowCostMs: 0.01,
    frameOfReferenceRowCostMs: 0.02,
    workerDispatchMs: 100,
    parallelEfficiency: 1,
  });
  const estimate = chunk.estimateBetween(-1, 200_000);
  const plan = planner.plan(estimate, 4);

  assert(estimate.rawRows === 256, "raw rows");
  assert(estimate.constantRows === 256, "constant rows");
  assert(estimate.frameOfReferenceRows === 256, "FOR rows");
  assert(plan.estimatedDirectMs === 18.36, `encoding-weighted cost ${plan.estimatedDirectMs}`);
  assert(plan.execution === "direct", "large dispatch keeps the direct path");
});

Deno.test("default Deno calibration preserves recorded adaptive encoding choices", () => {
  const planner = new PhysicalExecutionPlanner();
  const base = {
    rows: 8_388_608,
    pagesTotal: 32_768,
    pagesScanned: 32_768,
    pagesSkipped: 0,
  };
  const constant = planner.plan({
    ...base,
    rawRows: 0,
    constantRows: base.rows,
    frameOfReferenceRows: 0,
    rawPages: 0,
    constantPages: base.pagesScanned,
    frameOfReferencePages: 0,
  }, 8);
  const frameOfReference = planner.plan({
    ...base,
    rawRows: 0,
    constantRows: 0,
    frameOfReferenceRows: base.rows,
    rawPages: 0,
    constantPages: 0,
    frameOfReferencePages: base.pagesScanned,
  }, 8);
  const raw = planner.plan({
    ...base,
    rawRows: base.rows,
    constantRows: 0,
    frameOfReferenceRows: 0,
    rawPages: base.pagesScanned,
    constantPages: 0,
    frameOfReferencePages: 0,
  }, 8);

  assert(constant.execution === "direct", "O(1) constant pages stay direct");
  assert(frameOfReference.execution === "workers", "FOR decode repays Workers");
  assert(raw.execution === "workers", "large raw scan narrowly repays Workers");
});

Deno.test("I32GroupByU8Pipeline applies an operator-specific direct/Worker plan", async () => {
  const filter = Int32Array.from({ length: 1_024 }, (_, index) => index);
  const values = Int32Array.from({ length: 1_024 }, (_, index) => index - 512);
  const groups = Uint8Array.from({ length: 1_024 }, (_, index) => index & 7);
  await using pipeline = await I32GroupByU8Pipeline.create(
    { filter, values, groups },
    {
      groupCount: 8,
      workerCount: 4,
      pageRows: 128,
      costModel: {
        directPageOverheadMs: 0,
        workerPageOverheadMs: 0,
        rawRowCostMs: 1 / 128,
        constantRowCostMs: 1 / 128,
        frameOfReferenceRowCostMs: 1 / 128,
        workerDispatchMs: 2,
        parallelEfficiency: 1,
      },
    },
  );

  const selective = await pipeline.aggregateBetween(300, 340);
  const expectedSelective = groupByBetweenReference(filter, values, groups, 300, 340, 8);
  assert(selective.plan.execution === "direct", "one group-by page stays direct");
  assertGroupResults(selective.groups, expectedSelective.groups);

  const full = await pipeline.aggregateBetween(0, 1_024);
  const expectedFull = groupByBetweenReference(filter, values, groups, 0, 1_024, 8);
  assert(full.plan.execution === "workers", "large group-by uses Workers");
  assertGroupResults(full.groups, expectedFull.groups);

  const forced = await pipeline.aggregateBetween(300, 340, { execution: "workers" });
  assert(forced.plan.execution === "workers", "group-by execution can be forced");
  assertGroupResults(forced.groups, expectedSelective.groups);

  const replacement = {
    filter: new Int32Array(filter.length).fill(10_000),
    values: new Int32Array(values.length).fill(7),
    groups,
  };
  const generation = pipeline.replace(replacement);
  assert(pipeline.generation === generation, "group replacement publishes its generation");
  const pruned = await pipeline.aggregateBetween(300, 340);
  assert(pruned.plan.pagesScanned === 0, "replacement refreshes group-by pruning metadata");
  assert(pruned.groups.length === 0, "replacement values are queried");
  await pipeline.restartWorkers();
  const restarted = await pipeline.aggregateBetween(10_000, 10_001, { execution: "workers" });
  const expectedRestarted = groupByBetweenReference(
    replacement.filter,
    replacement.values,
    replacement.groups,
    10_000,
    10_001,
    8,
  );
  assertGroupResults(restarted.groups, expectedRestarted.groups);
});

Deno.test("Deno group-by calibration keeps the recorded 16/32-page crossover", () => {
  const planner = new PhysicalExecutionPlanner(DENO_I32_GROUP_BY_U8_COST_MODEL);
  const estimate = (pages: number) => ({
    rows: pages * 65_536,
    pagesTotal: 512,
    pagesScanned: pages,
    pagesSkipped: 512 - pages,
    rawRows: pages * 65_536,
    constantRows: 0,
    frameOfReferenceRows: 0,
    rawPages: pages,
    constantPages: 0,
    frameOfReferencePages: 0,
  });
  assert(planner.plan(estimate(16), 8).execution === "direct", "16 pages stay direct");
  assert(planner.plan(estimate(32), 8).execution === "workers", "32 pages use Workers");
});

Deno.test("Chromium count+sum calibration keeps the recorded 4/16-page crossover", () => {
  const planner = new PhysicalExecutionPlanner(CHROMIUM_I32_COUNT_SUM_COST_MODEL);
  const estimate = (pages: number) => ({
    rows: pages * 65_536,
    pagesTotal: 512,
    pagesScanned: pages,
    pagesSkipped: 512 - pages,
    rawRows: pages * 65_536,
    constantRows: 0,
    frameOfReferenceRows: 0,
    rawPages: pages,
    constantPages: 0,
    frameOfReferencePages: 0,
  });
  assert(planner.plan(estimate(4), 8).execution === "direct", "4 browser pages stay direct");
  assert(planner.plan(estimate(16), 8).execution === "workers", "16 browser pages use Workers");
});

Deno.test("Chromium adaptive calibration accounts for Worker page-claim overhead", () => {
  const planner = new PhysicalExecutionPlanner(CHROMIUM_I32_COUNT_SUM_COST_MODEL);
  const base = {
    rows: 8_388_608,
    pagesTotal: 32_768,
    pagesScanned: 32_768,
    pagesSkipped: 0,
  };
  const plan = (encoding: "raw" | "constant" | "frame-of-reference") =>
    planner.plan({
      ...base,
      rawRows: encoding === "raw" ? base.rows : 0,
      constantRows: encoding === "constant" ? base.rows : 0,
      frameOfReferenceRows: encoding === "frame-of-reference" ? base.rows : 0,
      rawPages: encoding === "raw" ? base.pagesScanned : 0,
      constantPages: encoding === "constant" ? base.pagesScanned : 0,
      frameOfReferencePages: encoding === "frame-of-reference" ? base.pagesScanned : 0,
    }, 8).execution;
  assert(plan("constant") === "direct", "constant pages avoid parallel claims");
  assert(plan("frame-of-reference") === "workers", "FOR decode repays page claims");
  assert(plan("raw") === "direct", "small raw pages remain direct at the measured tie");
});

function assertGroupResults(
  actual: readonly { group: number; count: number; sum: bigint; min: number; max: number }[],
  expected: readonly { group: number; count: number; sum: bigint; min: number; max: number }[],
): void {
  assert(actual.length === expected.length, "group result length");
  for (let index = 0; index < actual.length; index++) {
    const left = actual[index]!;
    const right = expected[index]!;
    assert(
      left.group === right.group && left.count === right.count && left.sum === right.sum &&
        left.min === right.min && left.max === right.max,
      `group result ${index}`,
    );
  }
}
