import { FlatHashSetU32 } from "../../src/flat-hash/mod.ts";

using set = FlatHashSetU32.from([1, 3, 5, 7]);
const queries = new Uint32Array([0, 1, 7]);
const present = new Uint8Array(queries.length);
set.lookupMany(queries, present);
document.body.textContent = present.join(",");
