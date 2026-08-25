import { RankSelectBitVectorBuilder } from "../../src/rank-select-bitvector/mod.ts";

const builder = new RankSelectBitVectorBuilder(1_000);
builder.insert(1).insert(10).insert(999);
using bits = builder.freeze();
document.body.textContent = String(bits.rank1(500));
