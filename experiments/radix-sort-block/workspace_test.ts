import { RadixSortBlockWorkspace } from "./workspace.ts";

function assertEquals<T extends Uint32Array | BigUint64Array>(actual: T, expected: T): void {
  if (actual.length !== expected.length) throw new Error("length mismatch");
  for (let index = 0; index < actual.length; index++) {
    if (actual[index] !== expected[index]) throw new Error(`value mismatch at ${index}`);
  }
}

Deno.test("RadixSortBlockWorkspace sorts complete unsigned u32 and u64 domains", async () => {
  await using workspace = await RadixSortBlockWorkspace.create(16);
  const u32 = Uint32Array.of(0xffff_ffff, 0, 7, 7, 0x8000_0000, 1, 0x7fff_ffff);
  const expectedU32 = u32.slice().sort();
  const outputU32 = new Uint32Array(u32.length);
  assertEquals(workspace.sortU32Into(u32, outputU32), expectedU32);

  const u64 = BigUint64Array.of(
    0xffff_ffff_ffff_ffffn,
    0n,
    7n,
    7n,
    0x8000_0000_0000_0000n,
    1n,
    0x7fff_ffff_ffff_ffffn,
  );
  const expectedU64 = u64.slice().sort();
  const outputU64 = new BigUint64Array(u64.length);
  assertEquals(workspace.sortU64Into(u64, outputU64), expectedU64);
});

Deno.test("RadixSortBlockWorkspace stably permutes u32 payloads with their keys", async () => {
  await using workspace = await RadixSortBlockWorkspace.create(16);
  const keys = Uint32Array.of(7, 1, 7, 0xffff_ffff, 0, 1);
  const rowIds = Uint32Array.of(0, 1, 2, 3, 4, 5);
  const outputKeys = new Uint32Array(keys.length);
  const outputRowIds = new Uint32Array(keys.length);

  workspace.sortU32PairsInto(keys, rowIds, outputKeys, outputRowIds);

  assertEquals(outputKeys, Uint32Array.of(0, 1, 1, 7, 7, 0xffff_ffff));
  assertEquals(outputRowIds, Uint32Array.of(4, 1, 5, 0, 2, 3));
});

Deno.test("RadixSortBlockWorkspace plans sorted, native-packed, and radix order paths", async () => {
  const length = 65_536;
  await using workspace = await RadixSortBlockWorkspace.create(length);
  const outputKeys = new Uint32Array(length);
  const outputRowIds = new Uint32Array(length);

  const sorted = Uint32Array.from({ length }, (_, index) => index >>> 1);
  assertEqualsValue(workspace.orderU32Into(sorted, outputKeys, outputRowIds), "already-sorted");
  assertStableOrder(sorted, outputKeys, outputRowIds);

  const lowCardinality = Uint32Array.from({ length }, (_, index) => (index * 17) & 255);
  assertEqualsValue(
    workspace.orderU32Into(lowCardinality, outputKeys, outputRowIds),
    "native-packed",
  );
  assertStableOrder(lowCardinality, outputKeys, outputRowIds);

  const random = Uint32Array.from(
    { length },
    (_, index) => Math.imul(index ^ length, 0x9e37_79b1) >>> 0,
  );
  assertEqualsValue(workspace.orderU32Into(random, outputKeys, outputRowIds), "wasm-radix");
  assertStableOrder(random, outputKeys, outputRowIds);
});

Deno.test("RadixSortBlockWorkspace consumes trusted column order metadata", async () => {
  const length = 65_536;
  await using workspace = await RadixSortBlockWorkspace.create(length);
  const outputKeys = new Uint32Array(length);
  const outputRowIds = new Uint32Array(length);
  const random = Uint32Array.from(
    { length },
    (_, index) => Math.imul(index ^ length, 0x9e37_79b1) >>> 0,
  );

  assertEqualsValue(
    workspace.orderU32Into(random, outputKeys, outputRowIds, {
      rowCount: length,
      ascending: false,
      adjacentInversions: length >>> 1,
      valueRange: 0x1_0000_0000,
    }),
    "wasm-radix",
  );
  assertStableOrder(random, outputKeys, outputRowIds);
  assertThrows(
    () =>
      workspace.orderU32Into(random, outputKeys, outputRowIds, {
        rowCount: length - 1,
        ascending: false,
        adjacentInversions: 1,
        valueRange: null,
      }),
    RangeError,
  );
});

Deno.test("RadixSortBlockWorkspace reuses capacity across randomized tails", async () => {
  const capacity = 4_097;
  await using workspace = await RadixSortBlockWorkspace.create(capacity);
  for (const length of [0, 1, 2, 15, 16, 255, 256, 257, 4_096, 4_097]) {
    const input = Uint32Array.from(
      { length },
      (_, index) => Math.imul(index ^ length, 0x9e37_79b1) >>> 0,
    );
    const expected = input.slice().sort();
    const output = new Uint32Array(length);
    assertEquals(workspace.sortU32Into(input, output), expected);

    const input64 = BigUint64Array.from(
      { length },
      (_, index) =>
        BigInt(Math.imul(index ^ length, 0x9e37_79b1) >>> 0) << 32n |
        BigInt(Math.imul(index + length, 0x85eb_ca6b) >>> 0),
    );
    const expected64 = input64.slice().sort();
    const output64 = new BigUint64Array(length);
    assertEquals(workspace.sortU64Into(input64, output64), expected64);
  }
});

Deno.test("RadixSortBlockWorkspace validates bounds and disposal", async () => {
  const workspace = await RadixSortBlockWorkspace.create(4);
  assertThrows(
    () => workspace.sortU32Into(new Uint32Array(5), new Uint32Array(5)),
    RangeError,
  );
  assertThrows(
    () => workspace.sortU64Into(new BigUint64Array(2), new BigUint64Array(1)),
    RangeError,
  );
  workspace[Symbol.dispose]();
  assertThrows(
    () => workspace.sortU32Into(Uint32Array.of(1), new Uint32Array(1)),
    Error,
  );
});

function assertThrows(operation: () => unknown, constructor: typeof Error): void {
  try {
    operation();
  } catch (error) {
    if (error instanceof constructor) return;
    throw error;
  }
  throw new Error("operation did not throw");
}

function assertEqualsValue(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`expected ${expected}, received ${actual}`);
}

function assertStableOrder(
  input: Uint32Array,
  outputKeys: Uint32Array,
  outputRowIds: Uint32Array,
): void {
  for (let index = 0; index < input.length; index++) {
    if (outputKeys[index] !== input[outputRowIds[index]!]) {
      throw new Error(`key/payload mismatch at ${index}`);
    }
    if (index === 0) continue;
    const previousKey = outputKeys[index - 1]!;
    const key = outputKeys[index]!;
    if (previousKey > key) throw new Error(`keys are not sorted at ${index}`);
    if (previousKey === key && outputRowIds[index - 1]! > outputRowIds[index]!) {
      throw new Error(`equal-key row IDs are not stable at ${index}`);
    }
  }
}
