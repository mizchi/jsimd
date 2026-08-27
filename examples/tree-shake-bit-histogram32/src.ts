import { BitHistogram32 } from "../../packages/jsimd/src/bit-histogram32/mod.ts";

using histogram = new BitHistogram32();
histogram.add(new Uint32Array([1, 3, 0xffff_ffff]));
const counts = new Uint32Array(32);
histogram.writeInto(counts);
document.body.textContent = counts.join(",");
