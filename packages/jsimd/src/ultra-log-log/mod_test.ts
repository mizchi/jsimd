import { UltraLogLogU32 } from "./mod.ts";
import { ParallelUltraLogLogU32 } from "../ultra-log-log-parallel/mod.ts";

Deno.test("UltraLogLogU32 estimates and incrementally merges deterministic u32 values", () => {
  const values = Uint32Array.from({ length: 100_003 }, (_, index) => mix32(index % 71_337));
  using whole = UltraLogLogU32.from(values, 12);
  using incremental = new UltraLogLogU32(12);
  incremental.addMany(values.subarray(0, 40_000));
  incremental.addMany(values.subarray(40_000));
  assertBytes(incremental.state(), whole.state());
  assertRelativeError(whole.estimate(), 71_337, 0.04);

  using left = UltraLogLogU32.from(values.subarray(0, 50_000), 12);
  using right = UltraLogLogU32.from(values.subarray(50_000), 12);
  left.merge(right);
  assertBytes(left.state(), whole.state());
});

Deno.test("UltraLogLogU32 plans small batches in JS and bulk batches in Wasm", () => {
  using sketch = new UltraLogLogU32(12);
  sketch.addMany(Uint32Array.from({ length: 4_096 }, (_, index) => index));
  assertEquals(sketch.lastAddStrategy, "javascript", "small strategy");
  sketch.replace(Uint32Array.from({ length: 65_536 }, (_, index) => index));
  assertEquals(sketch.lastAddStrategy, "wasm", "bulk strategy");
});

Deno.test("UltraLogLogU32 state import and using lifecycle preserve allocator balance", () => {
  const baseline = UltraLogLogU32.allocatorStats();
  let state: Uint8Array;
  {
    using source = UltraLogLogU32.from(Uint32Array.of(1, 2, 3, 3), 8);
    state = source.state();
    using restored = UltraLogLogU32.fromState(state);
    assertBytes(restored.state(), state);
    assertRelativeError(restored.estimate(), 3, 0.2);
  }
  const final = UltraLogLogU32.allocatorStats();
  assert(final.liveAllocations === baseline.liveAllocations, "live allocation balance");
  assert(final.liveBytes === baseline.liveBytes, "live byte balance");
});

Deno.test("ParallelUltraLogLogU32 selects serial and Worker execution without changing state", async () => {
  const small = Uint32Array.from({ length: 4_096 }, (_, index) => mix32(index % 3_000));
  const large = Uint32Array.from({ length: 65_536 }, (_, index) => mix32(index % 50_000));
  await using parallel = await ParallelUltraLogLogU32.create({
    precision: 12,
    maxValues: large.length,
    workerCount: 4,
    workerThreshold: large.length,
  });

  await parallel.replace(small);
  assertEquals(parallel.lastStrategy, "serial", "small parallel strategy");
  using smallReference = UltraLogLogU32.from(small, 12);
  assertBytes(parallel.state(), smallReference.state());

  await parallel.replace(large);
  assertEquals(parallel.lastStrategy, "workers", "large parallel strategy");
  using largeReference = UltraLogLogU32.from(large, 12);
  assertBytes(parallel.state(), largeReference.state());
  assertRelativeError(parallel.estimate(), 50_000, 0.04);
});

function mix32(value: number): number {
  let hash = value >>> 0;
  hash = Math.imul(hash ^ hash >>> 16, 0x7feb_352d);
  hash = Math.imul(hash ^ hash >>> 15, 0x846c_a68b);
  return (hash ^ hash >>> 16) >>> 0;
}

function assertBytes(actual: Uint8Array, expected: Uint8Array): void {
  assert(actual.length === expected.length, "state length");
  for (let index = 0; index < actual.length; index++) {
    if (actual[index] !== expected[index]) throw new Error(`state mismatch at ${index}`);
  }
}

function assertRelativeError(actual: number, expected: number, maximum: number): void {
  const error = Math.abs(actual - expected) / expected;
  if (error > maximum) throw new Error(`relative error ${error} exceeds ${maximum}`);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, received ${actual}`);
}
