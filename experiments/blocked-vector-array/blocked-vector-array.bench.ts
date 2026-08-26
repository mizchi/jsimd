import { afterAll, bench, describe } from "vitest";
import { BlockedVectorArray } from "../../src/blocked-vector-array/mod.ts";
import { PdxFloat32Index } from "../../src/binary-vector-index/mod.ts";

const LENGTH = 16_384;
const DIMENSIONS = 64;
const values = Float32Array.from(
  { length: LENGTH * DIMENSIONS },
  (_, index) => ((Math.imul(index + 1, 2_654_435_761) >>> 8) & 0xffff) / 32_768 - 1,
);
const query = values.slice(0, DIMENSIONS);
const output = new Float32Array(LENGTH);
let sink = 0;

function scalarSquaredL2(): void {
  for (let row = 0; row < LENGTH; row++) {
    let sum = 0;
    const offset = row * DIMENSIONS;
    for (let dimension = 0; dimension < DIMENSIONS; dimension++) {
      const delta = values[offset + dimension]! - query[dimension]!;
      sum += delta * delta;
    }
    output[row] = sum;
  }
}

describe("exact squared L2, 16K x 64", () => {
  const blocked = BlockedVectorArray.from(values, LENGTH, DIMENSIONS);
  const pdx4 = PdxFloat32Index.from(values, LENGTH, DIMENSIONS);
  afterAll(() => {
    blocked[Symbol.dispose]();
    pdx4[Symbol.dispose]();
  });

  bench("BlockedVectorArray PDX64", () => {
    blocked.squaredDistanceMany(query, output);
    sink += output[1]!;
  });

  bench("PdxFloat32Index PDX4", () => {
    pdx4.distanceMany(query, output);
    sink += output[1]!;
  });

  bench("Float32Array scalar", () => {
    scalarSquaredL2();
    sink += output[1]!;
  });
});

describe("row-major to blocked construction, 16K x 64", () => {
  bench("BlockedVectorArray.from PDX64", () => {
    using blocked = BlockedVectorArray.from(values, LENGTH, DIMENSIONS);
    sink += blocked.get(1, 1);
  });

  bench("PdxFloat32Index.from PDX4", () => {
    using pdx4 = PdxFloat32Index.from(values, LENGTH, DIMENSIONS);
    sink += pdx4.length;
  });

  bench("Float32Array.slice row-major", () => {
    const copy = values.slice();
    sink += copy[DIMENSIONS + 1]!;
  });
});

describe("small repeated exact squared L2, 32 x 64", () => {
  const length = 32;
  const dimensions = 64;
  const smallValues = values.slice(0, length * dimensions);
  const smallQuery = query.slice();
  const smallOutput = new Float32Array(length);
  const blocked = BlockedVectorArray.from(smallValues, length, dimensions);
  afterAll(() => blocked[Symbol.dispose]());

  bench("BlockedVectorArray PDX64", () => {
    blocked.squaredDistanceMany(smallQuery, smallOutput);
    sink += smallOutput[1]!;
  });

  bench("Float32Array scalar", () => {
    for (let row = 0; row < length; row++) {
      let sum = 0;
      const offset = row * dimensions;
      for (let dimension = 0; dimension < dimensions; dimension++) {
        const delta = smallValues[offset + dimension]! - smallQuery[dimension]!;
        sum += delta * delta;
      }
      smallOutput[row] = sum;
    }
    sink += smallOutput[1]!;
  });
});
