import { afterAll, bench, describe } from "vitest";
import { BitMatrix } from "../../packages/jsimd/src/bit-matrix/mod.ts";

let sink = 0;
const size = 512;
const stride = size >>> 5;
const edges: Array<readonly [number, number]> = [];
let state = 0x1234_5678;
for (let row = 0; row < size; row++) {
  for (let index = 0; index < 8; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    edges.push([row, state & (size - 1)]);
  }
}

function jsMatrix(): Uint32Array {
  const output = new Uint32Array(size * stride);
  for (const [row, column] of edges) output[row * stride + (column >>> 5)]! |= 1 << (column & 31);
  return output;
}

function jsMultiply(left: Uint32Array): Uint32Array {
  const transposed = new Uint32Array(left.length);
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      if ((left[row * stride + (column >>> 5)]! & (1 << (column & 31))) !== 0) {
        transposed[column * stride + (row >>> 5)]! |= 1 << (row & 31);
      }
    }
  }
  const output = new Uint32Array(left.length);
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      for (let word = 0; word < stride; word++) {
        if ((left[row * stride + word]! & transposed[column * stride + word]!) !== 0) {
          output[row * stride + (column >>> 5)]! |= 1 << (column & 31);
          break;
        }
      }
    }
  }
  return output;
}

describe("BitMatrix 512x512 sparse Boolean square", () => {
  const wasm = BitMatrix.fromEdges(size, size, edges);
  const js = jsMatrix();
  afterAll(() => wasm[Symbol.dispose]());

  bench("BitMatrix multiply", () => {
    using result = wasm.multiply(wasm);
    sink ^= result.countRowOnes(0);
  });
  bench("Uint32Array scalar multiply", () => {
    const result = jsMultiply(js);
    sink ^= result[0]!;
  });
});
