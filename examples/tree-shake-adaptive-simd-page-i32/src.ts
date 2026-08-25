import { AdaptiveSimdPageI32, SimdPageMask } from "../../src/adaptive-simd-page-i32/mod.ts";

using page = AdaptiveSimdPageI32.from([-3, 1, 4, 1, 5, 9, 2, 6]);
using selected = new SimdPageMask(page.length);
page.scanBetween(1, 6, selected);
document.body.textContent = selected.toIndices().join(",");
