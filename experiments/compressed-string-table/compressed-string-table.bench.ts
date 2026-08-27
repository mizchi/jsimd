import { afterAll, bench, describe } from "vitest";
import { CompressedStringTable } from "../../packages/jsimd/src/compressed-string-table/mod.ts";

const LENGTH = 65_536;
const QUERY_COUNT = 4096;
const encoder = new TextEncoder();
const strings = Array.from(
  { length: LENGTH },
  (_, index) =>
    `packages/compiler/src/generated/nodes/block-${index >>> 4}/node-${
      index.toString(16).padStart(8, "0")
    }.ts`,
);
const bytes = strings.map((value) => encoder.encode(value));
const ids = Uint32Array.from(
  { length: QUERY_COUNT },
  (_, index) => (index * 65_537) & (LENGTH - 1),
);
const queryList = Array.from(ids, (id, index) => {
  if ((index & 1) === 0) return bytes[id]!;
  return encoder.encode(`${strings[id]}-missing`);
});
const queryOffsets = new Uint32Array(QUERY_COUNT + 1);
let total = 0;
for (let index = 0; index < QUERY_COUNT; index++) {
  total += queryList[index]!.length;
  queryOffsets[index + 1] = total;
}
const queries = new Uint8Array(total);
for (let index = 0; index < QUERY_COUNT; index++) {
  queries.set(queryList[index]!, queryOffsets[index]);
}
let sink = 0;

describe("CompressedStringTable repeated queries", () => {
  const table = CompressedStringTable.from(bytes);
  const output = new Uint8Array(QUERY_COUNT);
  afterAll(() => table[Symbol.dispose]());
  bench("front-coded equalsMany x4096", () => {
    sink ^= table.equalsMany(ids, queries, queryOffsets, output)[0]!;
  });
  bench("Uint8Array scalar equality x4096", () => {
    let matches = 0;
    for (let query = 0; query < QUERY_COUNT; query++) {
      const left = bytes[ids[query]!]!;
      const right = queryList[query]!;
      let equal = left.length === right.length;
      for (let index = 0; equal && index < left.length; index++) {
        equal = left[index] === right[index];
      }
      matches += Number(equal);
    }
    sink ^= matches;
  });
  bench("string equality x4096 (pre-decoded)", () => {
    let matches = 0;
    for (let query = 0; query < QUERY_COUNT; query++) {
      matches += Number(
        strings[ids[query]!] ===
          (query & 1 ? `${strings[ids[query]!]}-missing` : strings[ids[query]!]),
      );
    }
    sink ^= matches;
  });
  bench("front-coded get x4096", () => {
    for (const id of ids) sink ^= table.get(id)[0]!;
  });
  bench("Uint8Array slice x4096", () => {
    for (const id of ids) sink ^= bytes[id]!.slice()[0]!;
  });
});
