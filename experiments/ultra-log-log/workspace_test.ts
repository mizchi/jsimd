import { JsUltraLogLog, mergeStates } from "./reference.ts";
import { UltraLogLogWorkspace } from "./workspace.ts";

Deno.test("UltraLogLogWorkspace matches the JavaScript register transition", async () => {
  const values = Uint32Array.from({ length: 50_003 }, (_, index) => mix32(index % 31_337));
  using reference = new JsUltraLogLog(12);
  reference.addU32Many(values);

  await using workspace = await UltraLogLogWorkspace.create({
    precision: 12,
    maxValues: values.length,
    shardCapacity: 2,
  });
  workspace.buildShard(0, values);
  const state = new Uint8Array(workspace.registerCount);
  workspace.shardStateInto(0, state);

  assertEquals(state, reference.state);
  assertRelativeError(workspace.estimateShard(0), 31_337, 0.04);
});

Deno.test("UltraLogLogWorkspace SIMD merge matches union ingestion", async () => {
  const left = Uint32Array.from({ length: 40_000 }, (_, index) => index);
  const right = Uint32Array.from({ length: 40_000 }, (_, index) => index + 20_000);
  const union = Uint32Array.from({ length: 60_000 }, (_, index) => index);

  await using workspace = await UltraLogLogWorkspace.create({
    precision: 12,
    maxValues: 60_000,
    shardCapacity: 2,
  });
  workspace.buildShard(0, left);
  workspace.buildShard(1, right);
  const merged = new Uint8Array(workspace.registerCount);
  workspace.mergeInto(2, merged);

  using reference = new JsUltraLogLog(12);
  reference.addU32Many(union);
  assertEquals(merged, reference.state);
  assertRelativeError(workspace.estimate(merged), 60_000, 0.04);
});

Deno.test("UltraLogLogWorkspace SIMD merge covers every rank difference and history", async () => {
  await using workspace = await UltraLogLogWorkspace.create({
    precision: 8,
    maxValues: 0,
    shardCapacity: 2,
  });
  const left = Uint8Array.from({ length: 256 }, (_, index) => index);
  const right = Uint8Array.from(
    { length: 256 },
    (_, index) => ((255 - index) & 0xfc) | (index * 3 & 3),
  );
  workspace.setShardState(0, left);
  workspace.setShardState(1, right);
  const actual = new Uint8Array(256);
  const expected = new Uint8Array(256);
  workspace.mergeInto(2, actual);
  mergeStates(left, right, expected);
  assertEquals(actual, expected);
});

Deno.test("UltraLogLogWorkspace validates capacity, state, and disposal", async () => {
  await assertRejects(() =>
    UltraLogLogWorkspace.create({ precision: 2, maxValues: 1, shardCapacity: 1 })
  );
  const workspace = await UltraLogLogWorkspace.create({
    precision: 8,
    maxValues: 4,
    shardCapacity: 1,
  });
  assertThrows(() => workspace.buildShard(0, new Uint32Array(5)));
  assertThrows(() => workspace.buildShard(1, new Uint32Array()));
  assertThrows(() => workspace.mergeInto(0, new Uint8Array(256)));
  assertThrows(() => workspace.estimate(new Uint8Array(255)));
  await workspace[Symbol.asyncDispose]();
  assertThrows(() => workspace.estimateShard(0));
});

function mix32(value: number): number {
  let hash = value >>> 0;
  hash = Math.imul(hash ^ hash >>> 16, 0x7feb_352d);
  hash = Math.imul(hash ^ hash >>> 15, 0x846c_a68b);
  return (hash ^ hash >>> 16) >>> 0;
}

function assertRelativeError(actual: number, expected: number, maximum: number): void {
  const error = Math.abs(actual - expected) / expected;
  if (error > maximum) throw new Error(`relative error ${error} exceeds ${maximum}`);
}

function assertEquals(actual: Uint8Array, expected: Uint8Array): void {
  if (actual.length !== expected.length) throw new Error("length mismatch");
  for (let index = 0; index < actual.length; index++) {
    if (actual[index] !== expected[index]) throw new Error(`state mismatch at ${index}`);
  }
}

function assertThrows(operation: () => unknown): void {
  try {
    operation();
  } catch {
    return;
  }
  throw new Error("operation did not throw");
}

async function assertRejects(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error("operation did not reject");
}
