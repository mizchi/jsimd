import {
  type RadixOrderStrategy,
  RadixOrderU32,
  type U32OrderFacts,
} from "@mizchi/jsimd-olap/radix-order-u32";

export async function orderU32(
  keys: Uint32Array,
  facts: U32OrderFacts,
): Promise<{ keys: Uint32Array; rowIds: Uint32Array; strategy: RadixOrderStrategy }> {
  const outputKeys = new Uint32Array(keys.length);
  const rowIds = new Uint32Array(keys.length);
  await using order = await RadixOrderU32.create(keys.length);
  const strategy = order.orderInto(keys, outputKeys, rowIds, facts);
  return { keys: outputKeys, rowIds, strategy };
}

Object.assign(globalThis, { orderU32 });
