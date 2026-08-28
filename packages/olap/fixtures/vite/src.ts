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

if (new URLSearchParams(location.search).has("smoke")) {
  const values = Int32Array.from({ length: 1_024 }, (_, index) => index);
  aggregateBetween(values, 100, 200).then(async (result) => {
    await fetch("/__jsimd_result", {
      method: "POST",
      body: JSON.stringify({ count: result.count, sum: result.sum.toString() }),
    });
  }).catch(async (error) => {
    await fetch("/__jsimd_result", {
      method: "POST",
      body: JSON.stringify({ error: error instanceof Error ? error.stack : String(error) }),
    });
  });
}
