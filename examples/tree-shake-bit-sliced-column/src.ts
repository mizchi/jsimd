import { BitSlicedColumnU8, BitSliceMask } from "../../packages/jsimd/src/bit-sliced-column/mod.ts";

using column = BitSlicedColumnU8.from(new Uint8Array([1, 4, 7, 10, 13]), 4);
using mask = new BitSliceMask(column.length);
column.between(4, 10, mask);
document.body.textContent = mask.toIndices().join(",");
