import { bench, describe } from "vitest";
import { SimdFloat32Vector } from "../../f32-vector.ts";

function scalarDot(left: Float32Array, right: Float32Array): number {
  let result = 0;
  for (let index = 0; index < left.length; index++) result += left[index]! * right[index]!;
  return result;
}

function scalarAxpy(target: Float32Array, source: Float32Array, scale: number): void {
  for (let index = 0; index < target.length; index++) {
    target[index] = target[index]! + source[index]! * scale;
  }
}

describe.each([16, 1_024, 16_384, 262_144, 4_194_304])("Float32Vector length=%i", (length) => {
  const leftArray = Float32Array.from({ length }, (_, index) => (index % 101) / 101);
  const rightArray = Float32Array.from({ length }, (_, index) => (index % 67) / 67);
  const left = SimdFloat32Vector.from(leftArray);
  const right = SimdFloat32Vector.from(rightArray);
  const scalarTarget = leftArray.slice();

  bench("SIMD dot", () => left.dot(right));
  bench("scalar Float32Array dot", () => scalarDot(leftArray, rightArray));
  bench("SIMD AXPY", () => left.addScaled(right, 1e-8));
  bench("scalar Float32Array AXPY", () => scalarAxpy(scalarTarget, rightArray, 1e-8));
});
