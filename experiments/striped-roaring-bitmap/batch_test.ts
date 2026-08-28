import { StripedRoaringIntersectionBatch } from "./batch.ts";

Deno.test("StripedRoaringIntersectionBatch evaluates resident pairs in input order", async () => {
  const pairs = [
    {
      left: Uint32Array.of(1, 2, 2, 65_536, 0xffff_ffff),
      right: Uint32Array.of(2, 3, 65_536, 65_536),
    },
    { left: new Uint32Array(), right: Uint32Array.of(1, 2) },
    {
      left: Uint32Array.from({ length: 8_192 }, (_, index) => index * 3),
      right: Uint32Array.from({ length: 8_192 }, (_, index) => index * 5),
    },
  ];

  await using batch = await StripedRoaringIntersectionBatch.create(pairs, { workerCount: 2 });
  const output = new Float64Array(pairs.length);
  const written = await batch.intersectionCardinalitiesInto(output);

  assertEquals(written, pairs.length);
  assertEquals(output, Float64Array.of(2, 0, 1_639));
  assertEquals(batch.pairCount, pairs.length);
  assertEquals(batch.workerCount, 2);
});

Deno.test("StripedRoaringIntersectionBatch validates contracts and lifetime", async () => {
  await assertRejects(() => StripedRoaringIntersectionBatch.create([], { workerCount: 1 }));
  await assertRejects(() =>
    StripedRoaringIntersectionBatch.create([
      { left: Uint32Array.of(1), right: Uint32Array.of(1) },
    ], { workerCount: 2 })
  );

  const batch = await StripedRoaringIntersectionBatch.create([
    { left: Uint32Array.of(1), right: Uint32Array.of(1) },
  ], { workerCount: 1 });
  await assertRejects(() => batch.intersectionCardinalitiesInto(new Float64Array()));
  await batch[Symbol.asyncDispose]();
  await assertRejects(() => batch.intersectionCardinalitiesInto(new Float64Array(1)));
});

function assertEquals(actual: unknown, expected: unknown): void {
  const left = ArrayBuffer.isView(actual) ? [...actual as Float64Array] : actual;
  const right = ArrayBuffer.isView(expected) ? [...expected as Float64Array] : expected;
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`expected ${JSON.stringify(right)}, received ${JSON.stringify(left)}`);
  }
}

async function assertRejects(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error("operation did not reject");
}
