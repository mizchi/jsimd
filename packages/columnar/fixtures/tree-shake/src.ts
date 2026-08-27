import {
  defineSchema,
  defineTable,
  IndexedDbPageBackend,
  SchemaEngine,
  u32,
} from "../../src/mod.ts";

const schema = defineSchema({ values: defineTable({ value: u32() }) });

export async function indexedDbRoundTrip(databaseName: string): Promise<number[]> {
  const backend = await IndexedDbPageBackend.open(databaseName);
  using engine = new SchemaEngine(schema, backend);
  await engine.replace("values", { value: Uint32Array.of(1, 2, 3) });
  const result = await engine.query("values").where("value", "lt", 3).select("value").execute();
  return Array.from(result.columns.value);
}

Object.assign(globalThis, { indexedDbRoundTrip });
