import {
  EliasFanoSequence,
  PartitionedEliasFanoSequence,
} from "../../src/elias-fano-sequence/mod.ts";

using offsets = EliasFanoSequence.from([1, 1, 3, 10, 100]);
using partitioned = PartitionedEliasFanoSequence.from([1, 2, 3, 1_000_000], 3);
document.body.textContent = `${offsets.nextGEQ(4)}:${partitioned.nextGEQ(4)}`;
