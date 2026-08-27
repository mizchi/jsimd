import { Bitmap, DenseBitmap } from "../../packages/jsimd/src/bitmap/mod.ts";

using bits = DenseBitmap.from(1024, [1, 2, 3]);
using selected = DenseBitmap.from(1024, [2]);
using growable = Bitmap.from([1, 2, 4096]);
document.body.textContent = String(bits.intersectionCount(selected) + growable.countOnes());
