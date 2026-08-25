import { ByteKeyFlatHashMapU32 } from "../../src/byte-key-flat-hash/mod.ts";

const key = new TextEncoder().encode("jsimd");
using map = new ByteKeyFlatHashMapU32();
map.set(key, 7);
document.body.textContent = String(map.get(key));
