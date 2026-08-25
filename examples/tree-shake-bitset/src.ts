import { FixedBitSet } from "../../src/bitset/mod.ts";

using bits = FixedBitSet.from(1024, [1, 2, 3]);
document.body.textContent = String(bits.countOnes());
