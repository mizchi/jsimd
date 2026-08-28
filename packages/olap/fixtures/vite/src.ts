import { I32AggregatePipeline } from "@mizchi/jsimd-olap/range-aggregate";

export async function aggregateBetween(
  values: Int32Array,
  minimum: number,
  maximum: number,
): Promise<{ count: number; sum: bigint }> {
  await using pipeline = await I32AggregatePipeline.create(values, {
    workerCount: 2,
    pageRows: 65_536,
  });
  const result = await pipeline.aggregateBetween(minimum, maximum);
  return { count: result.count, sum: result.sum };
}

Object.assign(globalThis, { aggregateBetween });
