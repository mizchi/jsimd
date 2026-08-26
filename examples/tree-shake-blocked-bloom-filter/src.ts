import { BlockedBloomFilterU32 } from "../../src/blocked-bloom-filter/mod.ts";

using filter = BlockedBloomFilterU32.from(Uint32Array.of(10, 20, 30, 40), 12);
const queries = Uint32Array.of(10, 11, 20, 21);
const possible = new Uint8Array(queries.length);
filter.mayContainMany(queries, possible);
document.body.textContent = possible.join(",");
