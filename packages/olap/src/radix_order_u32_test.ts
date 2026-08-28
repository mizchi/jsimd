import {
  defineSchema,
  defineTable,
  MemoryPageBackend,
  SchemaEngine,
  u32,
} from "@mizchi/jsimd-columnar";
import { RadixOrderU32 } from "./radix_order_u32.ts";

const schema = defineSchema({
  rows: defineTable({ key: u32() }, { rowGroupSize: 256 }),
});

Deno.test("RadixOrderU32 consumes column metadata and preserves stable row IDs", async () => {
  const length = 65_536;
  const random = Uint32Array.from(
    { length },
    (_, index) => Math.imul(index ^ length, 0x9e37_79b1) >>> 0,
  );
  const outputKeys = new Uint32Array(length);
  const outputRowIds = new Uint32Array(length);
  await using order = await RadixOrderU32.create(length);

  const randomFacts = await metadata(random);
  assert(order.orderInto(random, outputKeys, outputRowIds, randomFacts) === "wasm-radix");
  assertStableOrder(random, outputKeys, outputRowIds);

  const sorted = Uint32Array.from({ length }, (_, index) => index >>> 1);
  const sortedFacts = await metadata(sorted);
  assert(order.orderInto(sorted, outputKeys, outputRowIds, sortedFacts) === "already-sorted");
  assertStableOrder(sorted, outputKeys, outputRowIds);

  const lowCardinality = Uint32Array.from({ length }, (_, index) => (index * 17) & 255);
  const lowFacts = await metadata(lowCardinality);
  assert(order.orderInto(lowCardinality, outputKeys, outputRowIds, lowFacts) === "native-packed");
  assertStableOrder(lowCardinality, outputKeys, outputRowIds);
});

Deno.test("RadixOrderU32 falls back safely for legacy metadata and validates lifetime", async () => {
  const keys = Uint32Array.of(9, 1, 9, 2);
  const outputKeys = new Uint32Array(keys.length);
  const outputRowIds = new Uint32Array(keys.length);
  const order = await RadixOrderU32.create(keys.length);
  const strategy = order.orderInto(keys, outputKeys, outputRowIds, {
    rowCount: keys.length,
    ascending: undefined,
    adjacentInversions: undefined,
    valueRange: null,
  });
  assert(strategy === "native-packed");
  assertStableOrder(keys, outputKeys, outputRowIds);
  order[Symbol.dispose]();
  assertThrows(() =>
    order.orderInto(keys, outputKeys, outputRowIds, {
      rowCount: keys.length,
      ascending: false,
      adjacentInversions: 1,
      valueRange: 9,
    })
  );
});

async function metadata(values: Uint32Array) {
  const backend = new MemoryPageBackend();
  using engine = new SchemaEngine(schema, backend);
  await engine.replace("rows", { key: values });
  return await engine.readU32OrderMetadata("rows", "key");
}

function assertStableOrder(
  input: Uint32Array,
  outputKeys: Uint32Array,
  outputRowIds: Uint32Array,
): void {
  for (let index = 0; index < input.length; index++) {
    assert(outputKeys[index] === input[outputRowIds[index]!]!);
    if (index === 0) continue;
    assert(outputKeys[index - 1]! <= outputKeys[index]!);
    if (outputKeys[index - 1] === outputKeys[index]) {
      assert(outputRowIds[index - 1]! < outputRowIds[index]!);
    }
  }
}

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error("assertion failed");
}

function assertThrows(operation: () => unknown): void {
  try {
    operation();
  } catch {
    return;
  }
  throw new Error("operation did not throw");
}
