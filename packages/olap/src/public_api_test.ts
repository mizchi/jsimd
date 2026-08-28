import { I32GroupByU8Pipeline } from "./group_by_u8.ts";
import { I32AggregatePipeline } from "./range_aggregate.ts";
import { SparseU32GroupByQuery } from "./sparse_group_by_u32.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("public entry point executes range, dense group-by, and sparse group-by", async () => {
  const filter = Int32Array.from({ length: 1_024 }, (_, index) => index);

  await using aggregate = await I32AggregatePipeline.create(filter, {
    workerCount: 2,
    pageRows: 256,
  });
  const range = await aggregate.aggregateBetween(100, 200, { execution: "direct" });
  assert(range.count === 100 && range.sum === 14_950n, "range aggregate");

  const values = Int32Array.from({ length: filter.length }, (_, index) => index & 15);
  const groups = Uint8Array.from({ length: filter.length }, (_, index) => index & 3);
  await using dense = await I32GroupByU8Pipeline.create(
    { filter, values, groups },
    { groupCount: 4, workerCount: 2, pageRows: 256 },
  );
  const denseResult = await dense.aggregateBetween(100, 200, { execution: "direct" });
  assert(denseResult.groups.length === 4, "dense group count");

  const keys = Uint32Array.from({ length: filter.length }, (_, index) => index & 7);
  const validities = new Uint8Array(filter.length).fill(1);
  await using sparse = await SparseU32GroupByQuery.create(
    { filter, keys, values, validities },
    { capacity: 32, workerCount: 2, pageRows: 256 },
  );
  const sparseResult = await sparse.aggregateBetween(100, 200);
  assert(sparseResult.groups.length === 8, "sparse group count");
});
