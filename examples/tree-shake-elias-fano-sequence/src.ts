import { EliasFanoSequence } from "../../src/elias-fano-sequence/mod.ts";

using offsets = EliasFanoSequence.from([1, 1, 3, 10, 100]);
document.body.textContent = String(offsets.nextGEQ(4));
