import { FlatHashMapU64U32, FlatHashSetU32 } from "../../packages/jsimd/src/flat-hash/mod.ts";

using set = FlatHashSetU32.from([1, 3, 5, 7]);
const queries = new Uint32Array([0, 1, 7]);
const present = new Uint8Array(queries.length);
set.lookupMany(queries, present);
using wide = FlatHashMapU64U32.from([[0x1_0000_0000n, 42]]);
document.body.textContent = `${present.join(",")}:${wide.get(0x1_0000_0000n)}`;
