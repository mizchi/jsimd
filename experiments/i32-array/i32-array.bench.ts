import { afterAll, bench, describe } from "vitest";
import { SimdInt32Array } from "../../src/i32-array/mod.ts";

let sink = 0;

function typedSum(values: Int32Array): number {
  let result = 0;
  for (let index = 0; index < values.length; index++) result += values[index]!;
  return result;
}

function arraySum(values: number[]): number {
  let result = 0;
  for (let index = 0; index < values.length; index++) result += values[index]!;
  return result;
}

function typedMin(values: Int32Array): number {
  let result = values[0]!;
  for (let index = 1; index < values.length; index++) {
    if (values[index]! < result) result = values[index]!;
  }
  return result;
}

function arrayMin(values: number[]): number {
  let result = values[0]!;
  for (let index = 1; index < values.length; index++) {
    if (values[index]! < result) result = values[index]!;
  }
  return result;
}

function typedAddAssign(target: Int32Array, source: Int32Array): void {
  for (let index = 0; index < target.length; index++) {
    target[index] = target[index]! + source[index]!;
  }
}

function arrayAddAssign(target: number[], source: number[]): void {
  for (let index = 0; index < target.length; index++) {
    target[index] = (target[index]! + source[index]!) | 0;
  }
}

describe.each([1_024, 16_384, 262_144, 4_194_304])(
  "SimdInt32Array length=%i",
  (length) => {
    const values = Int32Array.from({ length }, (_, index) => (index % 1009) - 504);
    const source = Int32Array.from({ length }, (_, index) => (index % 127) - 63);
    const numberValues = Array.from(values);
    const numberSource = Array.from(source);
    const simdValues = SimdInt32Array.from(values);
    const simdSource = SimdInt32Array.from(source);
    const typedTarget = values.slice();
    const arrayTarget = numberValues.slice();

    afterAll(() => {
      simdValues.dispose();
      simdSource.dispose();
    });

    bench("SIMD sum", () => {
      sink ^= simdValues.sum();
    });
    bench("Int32Array sum", () => {
      sink ^= typedSum(values);
    });
    bench("Array<number> sum", () => {
      sink ^= arraySum(numberValues);
    });
    bench("SIMD min", () => {
      sink ^= simdValues.min();
    });
    bench("Int32Array min", () => {
      sink ^= typedMin(values);
    });
    bench("Array<number> min", () => {
      sink ^= arrayMin(numberValues);
    });
    bench("SIMD addAssign", () => {
      simdValues.addAssign(simdSource);
    });
    bench("Int32Array addAssign", () => {
      typedAddAssign(typedTarget, source);
    });
    bench("Array<number> addAssign", () => {
      arrayAddAssign(arrayTarget, numberSource);
    });
  },
);
