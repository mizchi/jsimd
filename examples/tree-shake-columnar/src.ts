import {
  AdaptiveI32Column,
  AdaptiveU32Column,
  BitSlicedU8Column,
  SelectionMask,
} from "../../src/columnar/mod.ts";

using prices = AdaptiveI32Column.from(Int32Array.of(100, 220, 180, 310));
using kinds = BitSlicedU8Column.from(Uint8Array.of(1, 2, 2, 1), 2);
using ids = AdaptiveU32Column.from(Uint32Array.of(0xffff_ff00, 20, 30, 0xffff_ff10));
using selected = new SelectionMask(prices.length);
using temporary = new SelectionMask(prices.length);
prices.scanBetween(150, 300, selected);
kinds.scanEq(2, temporary);
selected.andAssign(temporary);
ids.scanLt(0x8000_0000, temporary);
selected.andAssign(temporary);
document.body.textContent = selected.toIndices().join(",");
