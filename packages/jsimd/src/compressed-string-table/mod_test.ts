import { CompressedStringTable } from "../compressed-string-table/mod.ts";
import { assertEquals } from "../../test/assert.ts";

Deno.test("CompressedStringTable preserves front-coded arbitrary byte strings", () => {
  const encoder = new TextEncoder();
  const keys = [
    encoder.encode("src/components/button/render.ts"),
    encoder.encode("src/components/button/style.ts"),
    encoder.encode("src/components/input/render.ts"),
    Uint8Array.of(0, 1, 0, 2),
  ];
  using table = CompressedStringTable.from(keys);
  assertEquals(table.length, keys.length, "length");
  for (let id = 0; id < keys.length; id++) {
    assertEquals(table.get(id).join(","), keys[id]!.join(","), `get id=${id}`);
    assertEquals(table.equals(id, keys[id]!), true, `equals id=${id}`);
  }
  assertEquals(table.equals(0, encoder.encode("src/components/button/style.ts")), false, "miss");
});

Deno.test("CompressedStringTable batches equality without decoding", () => {
  const encoder = new TextEncoder();
  const keys = Array.from(
    { length: 64 },
    (_, index) =>
      encoder.encode(`packages/compiler/src/shared-prefix-${index.toString(16).padStart(4, "0")}`),
  );
  using table = CompressedStringTable.from(keys);
  const ids = Uint32Array.of(0, 17, 63, 10);
  const queryList = [keys[0]!, keys[17]!, encoder.encode("missing"), keys[11]!];
  const queryOffsets = new Uint32Array(queryList.length + 1);
  let total = 0;
  for (let index = 0; index < queryList.length; index++) {
    total += queryList[index]!.length;
    queryOffsets[index + 1] = total;
  }
  const queries = new Uint8Array(total);
  for (let index = 0; index < queryList.length; index++) {
    queries.set(queryList[index]!, queryOffsets[index]);
  }
  assertEquals(table.equalsMany(ids, queries, queryOffsets).join(","), "1,1,0,0", "matches");
  assertEquals(table.encodedBytes < table.uncompressedBytes, true, "front coding saves space");
});

Deno.test("CompressedStringTable using lifecycle returns allocator storage", () => {
  const before = CompressedStringTable.allocatorStats();
  {
    using table = CompressedStringTable.from(
      Array.from({ length: 1_000 }, (_, index) => new TextEncoder().encode(`common/${index}`)),
    );
    assertEquals(table.length, 1_000, "resident table");
  }
  const after = CompressedStringTable.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});
