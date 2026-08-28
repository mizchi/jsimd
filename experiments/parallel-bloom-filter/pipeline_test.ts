import { ParallelBlockedBloomFilterU32 } from "./pipeline.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("parallel Bloom builds Worker-local shards and publishes their union", async () => {
  const keys = Uint32Array.from({ length: 32_768 }, (_, index) => hash(index));
  const queries = Uint32Array.from(
    { length: 65_536 },
    (_, index) => hash(index < keys.length ? index : index + keys.length),
  );
  await using filter = await ParallelBlockedBloomFilterU32.create({
    maxBuildKeys: keys.length,
    maxQueryKeys: queries.length,
    workerCount: 4,
    targetBitsPerKey: 12,
  });

  const generation = await filter.replace(keys);
  assert(generation === 1, "first generation");
  const output = new Uint8Array(queries.length);
  const candidates = filter.mayContainMany(queries, output);
  assert(candidates >= keys.length, "inserted keys must be candidates");
  for (let index = 0; index < keys.length; index++) {
    assert(output[index] === 1, `false negative at ${index}`);
  }
  assert(candidates < queries.length, "absent keys should be rejected");
});

Deno.test("parallel Bloom replaces generations and validates lifecycle bounds", async () => {
  await using filter = await ParallelBlockedBloomFilterU32.create({
    maxBuildKeys: 128,
    maxQueryKeys: 256,
    workerCount: 2,
    targetBitsPerKey: 10,
  });
  assert(filter.blockCount > 0 && filter.byteLength > 0, "layout");
  assert(await filter.replace(Uint32Array.of(1, 2, 3)) === 1, "generation one");
  assert(await filter.replace(Uint32Array.of(100, 200)) === 2, "generation two");
  const output = new Uint8Array(4);
  filter.mayContainMany(Uint32Array.of(100, 200, 300, 400), output);
  assert(output[0] === 1 && output[1] === 1, "replacement keys");

  await assertRejects(
    () => filter.replace(new Uint32Array(129)),
    RangeError,
    "build capacity",
  );
  assertThrows(
    () => filter.mayContainMany(new Uint32Array(257), new Uint8Array(257)),
    RangeError,
    "query capacity",
  );
  assertThrows(
    () => filter.mayContainMany(Uint32Array.of(1), new Uint8Array(0)),
    RangeError,
    "output capacity",
  );
});

Deno.test("parallel Bloom serializes replacement and rejects use after disposal", async () => {
  const filter = await ParallelBlockedBloomFilterU32.create({
    maxBuildKeys: 1 << 16,
    maxQueryKeys: 4,
    workerCount: 2,
  });
  const replacement = filter.replace(
    Uint32Array.from({ length: 1 << 16 }, (_, index) => hash(index)),
  );
  await assertRejects(
    () => filter.replace(Uint32Array.of(1)),
    Error,
    "concurrent replacement",
  );
  assertThrows(
    () => filter.mayContainMany(Uint32Array.of(1), new Uint8Array(1)),
    Error,
    "query during replacement",
  );
  await replacement;
  await filter[Symbol.asyncDispose]();
  await assertRejects(
    () => filter.replace(Uint32Array.of(1)),
    Error,
    "replacement after disposal",
  );
  assertThrows(
    () => filter.mayContainMany(Uint32Array.of(1), new Uint8Array(1)),
    Error,
    "query after disposal",
  );
});

function hash(value: number): number {
  return Math.imul(value, 0x9e37_79b1) >>> 0;
}

async function assertRejects(
  operation: () => Promise<unknown>,
  constructor: typeof Error,
  message: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof constructor) return;
    throw error;
  }
  throw new Error(message);
}

function assertThrows(operation: () => unknown, constructor: typeof Error, message: string): void {
  try {
    operation();
  } catch (error) {
    if (error instanceof constructor) return;
    throw error;
  }
  throw new Error(message);
}
