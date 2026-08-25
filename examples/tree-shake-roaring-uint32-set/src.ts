import { RoaringUint32Set } from "../../src/roaring-uint32-set/mod.ts";

using left = RoaringUint32Set.from([1, 2, 65_536]);
using right = RoaringUint32Set.from([2, 65_536, 70_000]);
using output = new RoaringUint32Set();
left.andInto(right, output);
document.body.textContent = String(output.size);
