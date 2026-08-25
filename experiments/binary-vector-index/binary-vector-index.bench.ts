import { afterAll, bench, describe } from "vitest";
import { BinaryVectorIndex } from "../../src/binary-vector-index/mod.ts";
const N = 65_536, BYTES = 32;
const rows = Array.from(
  { length: N },
  (_, r) => Uint8Array.from({ length: BYTES }, (_, b) => Math.imul(r + 1, b + 17)),
);
const query = Uint8Array.from({ length: BYTES }, (_, i) => Math.imul(i, 31));
const table = Uint8Array.from({ length: 256 }, (_, x) => x.toString(2).split("1").length - 1);
let sink = 0;
describe("BinaryVectorIndex 256-bit Hamming", () => {
  const index = BinaryVectorIndex.fromSignatures(rows);
  const output = new Uint32Array(N);
  afterAll(() => index[Symbol.dispose]());
  bench("Wasm SIMD distanceMany", () => {
    index.distanceMany(query, output);
    sink ^= output[0]!;
  });
  bench("JS scalar distanceMany", () => {
    for (let r = 0; r < N; r++) {
      let d = 0;
      for (let b = 0; b < BYTES; b++) d += table[rows[r]![b]! ^ query[b]!]!;
      output[r] = d;
    }
    sink ^= output[0]!;
  });
});
