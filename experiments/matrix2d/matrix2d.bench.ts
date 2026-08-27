import { afterAll, bench, describe } from "vitest";
import { SimdMatrix2D } from "../../packages/jsimd/src/matrix2d/mod.ts";

let sink = 0;

function typedMatmul(
  left: Float32Array,
  right: Float32Array,
  output: Float32Array,
  size: number,
): void {
  output.fill(0);
  for (let row = 0; row < size; row++) {
    const leftRow = row * size;
    const outputRow = row * size;
    for (let index = 0; index < size; index++) {
      const value = left[leftRow + index]!;
      const rightRow = index * size;
      for (let column = 0; column < size; column++) {
        output[outputRow + column] = output[outputRow + column]! +
          value * right[rightRow + column]!;
      }
    }
  }
}

function arrayMatmul(left: number[], right: number[], output: number[], size: number): void {
  output.fill(0);
  for (let row = 0; row < size; row++) {
    const leftRow = row * size;
    const outputRow = row * size;
    for (let index = 0; index < size; index++) {
      const value = left[leftRow + index]!;
      const rightRow = index * size;
      for (let column = 0; column < size; column++) {
        output[outputRow + column] = Math.fround(
          output[outputRow + column]! + value * right[rightRow + column]!,
        );
      }
    }
  }
}

describe.each([4, 16, 32, 64, 128, 256])("Matrix2D square size=%i", (size) => {
  const length = size * size;
  const leftValues = Float32Array.from({ length }, (_, index) => (index % 101) / 101 - 0.5);
  const rightValues = Float32Array.from({ length }, (_, index) => (index % 67) / 67 - 0.5);
  const leftArray = Array.from(leftValues);
  const rightArray = Array.from(rightValues);
  const simdLeft = SimdMatrix2D.from(size, size, leftValues);
  const simdRight = SimdMatrix2D.from(size, size, rightValues);
  const simdOutput = new SimdMatrix2D(size, size);
  const typedOutput = new Float32Array(length);
  const arrayOutput = new Array<number>(length).fill(0);

  afterAll(() => {
    simdLeft.dispose();
    simdRight.dispose();
    simdOutput.dispose();
  });

  bench("SIMD multiplyInto", () => {
    simdLeft.multiplyInto(simdRight, simdOutput);
    sink ^= simdOutput.get(0, 0) | 0;
  });
  bench("Float32Array matmul", () => {
    typedMatmul(leftValues, rightValues, typedOutput, size);
    sink ^= typedOutput[0]! | 0;
  });
  bench("Array<number> matmul", () => {
    arrayMatmul(leftArray, rightArray, arrayOutput, size);
    sink ^= arrayOutput[0]! | 0;
  });
});
