import { afterAll, bench, describe } from "vitest";
import { BinaryVectorIndex, PdxFloat32Index } from "../../src/binary-vector-index/mod.ts";
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

const FLOAT_N = 16_384, DIMENSIONS = 64;
const floatRows = Float32Array.from(
  { length: FLOAT_N * DIMENSIONS },
  (_, index) => ((Math.imul(index + 1, 2654435761) >>> 8) & 0xffff) / 32768 - 1,
);
const floatQuery = floatRows.slice(0, DIMENSIONS);
function scalarL2(output: Float32Array): void {
  for (let row = 0; row < FLOAT_N; row++) {
    let sum = 0;
    for (let dimension = 0; dimension < DIMENSIONS; dimension++) {
      const delta = floatRows[row * DIMENSIONS + dimension]! - floatQuery[dimension]!;
      sum += delta * delta;
    }
    output[row] = sum;
  }
}
describe("PdxFloat32Index exact L2, 16K x 64", () => {
  const index = PdxFloat32Index.from(floatRows, FLOAT_N, DIMENSIONS);
  const output = new Float32Array(FLOAT_N);
  afterAll(() => index[Symbol.dispose]());
  bench("PDX f32x4 distanceMany", () => {
    index.distanceMany(floatQuery, output);
    sink ^= output[1]!;
  });
  bench("Float32Array scalar L2", () => {
    scalarL2(output);
    sink ^= output[1]!;
  });
});
