import { afterAll, bench, describe } from "vitest";
import { BitVector } from "../../src/bit-vector/mod.ts";

const NODE_COUNT = 87_381;
const QUERY_COUNT = 4096;
const words = new Uint32Array(Math.ceil((NODE_COUNT * 2 + 1) / 32));
const parents = new Uint32Array(NODE_COUNT);
let bit = 0;
setBit(bit++); // Standard LOUDS super-root edge.
bit++; // Super-root terminator.
let nextChild = 1;
for (let node = 0; node < NODE_COUNT; node++) {
  const degree = Math.min(4, NODE_COUNT - nextChild);
  for (let child = 0; child < degree; child++) {
    setBit(bit++);
    parents[nextChild++] = node;
  }
  bit++;
}
const nodes = Uint32Array.from(
  { length: QUERY_COUNT },
  (_, index) => 1 + ((index * 65_537) % (NODE_COUNT - 1)),
);
const positions = new Int32Array(QUERY_COUNT);
const ends = new Uint32Array(QUERY_COUNT);
const ranks = new Uint32Array(QUERY_COUNT);
let sink = 0;

describe("rejected LOUDS parent navigation", () => {
  const louds = BitVector.fromUint32Array(bit, words.subarray(0, Math.ceil(bit / 32)));
  afterAll(() => louds[Symbol.dispose]());
  bench("LOUDS select+rank parentMany x4096", () => {
    louds.select1Many(nodes, positions);
    for (let index = 0; index < positions.length; index++) ends[index] = positions[index]!;
    louds.rank1Many(ends, ranks);
    for (let index = 0; index < positions.length; index++) {
      sink ^= positions[index]! - ranks[index]! - 1;
    }
  });
  bench("Uint32Array parent x4096", () => {
    for (const node of nodes) sink ^= parents[node]!;
  });
});

function setBit(position: number): void {
  words[position >>> 5] |= 1 << (position & 31);
}
