import { BitSet, FixedBitSet } from "../../src/bitset/mod.ts";

using bits = FixedBitSet.from(1024, [1, 2, 3]);
using selected = FixedBitSet.from(1024, [2]);
using growable = BitSet.from([1, 2, 4096]);
document.body.textContent = String(bits.intersectionCount(selected) + growable.countOnes());
