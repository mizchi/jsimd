import { JsUltraLogLog } from "./reference.ts";
import { ParallelUltraLogLogU32 } from "./parallel.ts";

Deno.test("ParallelUltraLogLogU32 matches serial ingestion across replacements", async () => {
  const first = Uint32Array.from({ length: 50_003 }, (_, index) => mix32(index % 31_337));
  const second = Uint32Array.from({ length: 61_003 }, (_, index) => mix32(index % 42_337));
  await using parallel = await ParallelUltraLogLogU32.create({
    precision: 12,
    maxValues: second.length,
    workerCount: 4,
  });
  const output = new Uint8Array(parallel.registerCount);

  for (const values of [first, second]) {
    using reference = new JsUltraLogLog(12);
    reference.addU32Many(values);
    const estimate = await parallel.replace(values, output);
    assertEquals(output, reference.state);
    assertRelativeError(estimate, reference.estimate(), 1e-12);
  }
});

Deno.test("ParallelUltraLogLogU32 validates capacity and disposal", async () => {
  const parallel = await ParallelUltraLogLogU32.create({
    precision: 8,
    maxValues: 4,
    workerCount: 2,
  });
  await assertRejects(() => parallel.replace(new Uint32Array(5), new Uint8Array(256)));
  await assertRejects(() => parallel.replace(new Uint32Array(4), new Uint8Array(255)));
  await parallel[Symbol.asyncDispose]();
  await assertRejects(() => parallel.replace(new Uint32Array(4), new Uint8Array(256)));
});

function mix32(value: number): number {
  let hash = value >>> 0;
  hash = Math.imul(hash ^ hash >>> 16, 0x7feb_352d);
  hash = Math.imul(hash ^ hash >>> 15, 0x846c_a68b);
  return (hash ^ hash >>> 16) >>> 0;
}

function assertEquals(actual: Uint8Array, expected: Uint8Array): void {
  if (actual.length !== expected.length) throw new Error("length mismatch");
  for (let index = 0; index < actual.length; index++) {
    if (actual[index] !== expected[index]) throw new Error(`state mismatch at ${index}`);
  }
}

function assertRelativeError(actual: number, expected: number, maximum: number): void {
  const error = Math.abs(actual - expected) / expected;
  if (error > maximum) throw new Error(`relative error ${error} exceeds ${maximum}`);
}

async function assertRejects(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error("operation did not reject");
}
