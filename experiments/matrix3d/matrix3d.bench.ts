import { afterAll, bench, describe } from "vitest";
import { SimdMatrix3D } from "../../packages/jsimd/src/matrix3d/mod.ts";

let sink = 0;

function typedBatchedMatmul(
  left: Float32Array,
  right: Float32Array,
  output: Float32Array,
  batches: number,
  rows: number,
  inner: number,
  columns: number,
): void {
  output.fill(0);
  for (let batch = 0; batch < batches; batch++) {
    for (let row = 0; row < rows; row++) {
      const leftRow = (batch * rows + row) * inner;
      const outputRow = (batch * rows + row) * columns;
      for (let index = 0; index < inner; index++) {
        const value = left[leftRow + index]!;
        const rightRow = (batch * inner + index) * columns;
        for (let column = 0; column < columns; column++) {
          output[outputRow + column] = output[outputRow + column]! +
            value * right[rightRow + column]!;
        }
      }
    }
  }
}

function arrayBatchedMatmul(
  left: number[],
  right: number[],
  output: number[],
  batches: number,
  rows: number,
  inner: number,
  columns: number,
): void {
  output.fill(0);
  for (let batch = 0; batch < batches; batch++) {
    for (let row = 0; row < rows; row++) {
      const leftRow = (batch * rows + row) * inner;
      const outputRow = (batch * rows + row) * columns;
      for (let index = 0; index < inner; index++) {
        const value = left[leftRow + index]!;
        const rightRow = (batch * inner + index) * columns;
        for (let column = 0; column < columns; column++) {
          output[outputRow + column] = Math.fround(
            output[outputRow + column]! + value * right[rightRow + column]!,
          );
        }
      }
    }
  }
}

describe.each(
  [
    [1, 16, 16, 16],
    [16, 16, 16, 16],
    [64, 8, 8, 8],
    [16, 32, 32, 32],
    [8, 64, 64, 64],
  ] as const,
)("Matrix3D B=%i M=%i K=%i N=%i", (batches, rows, inner, columns) => {
  const leftLength = batches * rows * inner;
  const rightLength = batches * inner * columns;
  const outputLength = batches * rows * columns;
  const leftValues = Float32Array.from(
    { length: leftLength },
    (_, index) => (index % 101) / 101 - 0.5,
  );
  const rightValues = Float32Array.from(
    { length: rightLength },
    (_, index) => (index % 67) / 67 - 0.5,
  );
  const leftArray = Array.from(leftValues);
  const rightArray = Array.from(rightValues);
  const simdLeft = SimdMatrix3D.from(batches, rows, inner, leftValues);
  const simdRight = SimdMatrix3D.from(batches, inner, columns, rightValues);
  const simdOutput = new SimdMatrix3D(batches, rows, columns);
  const typedOutput = new Float32Array(outputLength);
  const arrayOutput = new Array<number>(outputLength).fill(0);

  afterAll(() => {
    simdLeft.dispose();
    simdRight.dispose();
    simdOutput.dispose();
  });

  bench("SIMD batchMultiplyInto", () => {
    simdLeft.batchMultiplyInto(simdRight, simdOutput);
    sink ^= simdOutput.get(0, 0, 0) | 0;
  });
  bench("Float32Array batched matmul", () => {
    typedBatchedMatmul(
      leftValues,
      rightValues,
      typedOutput,
      batches,
      rows,
      inner,
      columns,
    );
    sink ^= typedOutput[0]! | 0;
  });
  bench("Array<number> batched matmul", () => {
    arrayBatchedMatmul(
      leftArray,
      rightArray,
      arrayOutput,
      batches,
      rows,
      inner,
      columns,
    );
    sink ^= arrayOutput[0]! | 0;
  });
});
