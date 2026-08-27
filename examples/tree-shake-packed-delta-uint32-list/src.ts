import { PackedDeltaUint32List } from "../../packages/jsimd/src/packed-delta-uint32-list/mod.ts";

using postings = PackedDeltaUint32List.from([1, 3, 10, 100, 1_000]);
const output = new Uint32Array(3);
postings.decodeInto(1, output);
document.body.textContent = output.join(",");
