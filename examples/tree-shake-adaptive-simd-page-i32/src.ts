import {
  AdaptiveSimdColumnI32,
  SimdColumnMask,
} from "../../packages/jsimd/src/adaptive-simd-page-i32/mod.ts";

using page = AdaptiveSimdColumnI32.from([-3, 1, 4, 1, 5, 9, 2, 6]);
using selected = new SimdColumnMask(page.length);
page.scanBetween(1, 6, selected);
document.body.textContent = selected.toIndices().join(",");
