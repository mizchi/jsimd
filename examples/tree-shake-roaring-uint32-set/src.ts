import { RoaringBitmap } from "../../src/roaring-uint32-set/mod.ts";

using left = RoaringBitmap.from([1, 2, 65_536]);
using right = RoaringBitmap.from([2, 65_536, 70_000]);
using output = new RoaringBitmap();
left.andInto(right, output);
document.body.textContent = String(output.size);
