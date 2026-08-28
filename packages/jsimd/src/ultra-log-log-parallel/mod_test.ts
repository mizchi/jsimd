import { ParallelUltraLogLogU32 } from "./mod.ts";

Deno.test("parallel UltraLogLog public subpath initializes and disposes", async () => {
  await using sketch = await ParallelUltraLogLogU32.create({
    precision: 8,
    maxValues: 4,
    workerCount: 2,
  });
  const estimate = await sketch.replace(Uint32Array.of(1, 2, 2, 3));
  if (Math.abs(estimate - 3) > 1) throw new Error(`unexpected estimate ${estimate}`);
});
