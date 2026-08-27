import { FlatHashMapFixed16U32 } from "../../packages/jsimd/src/flat-hash-fixed16/mod.ts";

const key = new Uint8Array(16);
key[0] = 42;
using map = new FlatHashMapFixed16U32();
map.set(key, 7);
document.body.textContent = String(map.get(key));
