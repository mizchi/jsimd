import { ParallelUltraLogLogU32 } from "../../packages/jsimd/src/ultra-log-log-parallel/mod.ts";

await using sketch = await ParallelUltraLogLogU32.create({
  precision: 8,
  maxValues: 65_536,
  workerCount: 2,
});
await sketch.replace(Uint32Array.from({ length: 65_536 }, (_, index) => index));
document.querySelector<HTMLDivElement>("#app")!.textContent = String(sketch.estimate());
