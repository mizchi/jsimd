import { afterAll, bench, describe } from "vitest";
import { PackedDeltaUint32List } from "../../packages/jsimd/src/packed-delta-uint32-list/mod.ts";

let sink = 0;

function arithmeticValues(length: number, step: number): Uint32Array {
  return Uint32Array.from({ length }, (_, index) => index * step + 1);
}

function variableDeltaValues(length: number): Uint32Array {
  const output = new Uint32Array(length);
  let value = 0;
  for (let index = 0; index < length; index++) {
    value += 1 + ((Math.imul(index, 2_654_435_761) >>> 27) & 31);
    output[index] = value;
  }
  return output;
}

function scalarLowerBound(values: Uint32Array, target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function scalarIntersectionInto(
  left: Uint32Array,
  right: Uint32Array,
  output: Uint32Array,
): number {
  let leftIndex = 0;
  let rightIndex = 0;
  let written = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const a = left[leftIndex]!;
    const b = right[rightIndex]!;
    if (a < b) leftIndex++;
    else if (a > b) rightIndex++;
    else {
      output[written++] = a;
      leftIndex++;
      rightIndex++;
    }
  }
  return written;
}

describe.each(
  [
    ["small deltas", arithmeticValues(262_144, 3)],
    ["variable deltas", variableDeltaValues(262_144)],
  ] as const,
)("PackedDeltaUint32List %s", (_name, values) => {
  const packed = PackedDeltaUint32List.fromUint32Array(values);
  const output = new Uint32Array(values.length);
  const queries = Uint32Array.from(
    { length: 1_024 },
    (_, index) => values[(index * 251) & (values.length - 1)]!,
  );

  afterAll(() => packed[Symbol.dispose]());

  bench("PackedDelta decodeInto", () => {
    sink ^= packed.decodeInto(0, output);
  });
  bench("Uint32Array set", () => {
    output.set(values);
    sink ^= output[output.length - 1]!;
  });
  bench("PackedDelta lowerBound x1024", () => {
    let total = 0;
    for (const query of queries) total += packed.lowerBound(query);
    sink ^= total;
  });
  bench("Uint32Array lowerBound x1024", () => {
    let total = 0;
    for (const query of queries) total += scalarLowerBound(values, query);
    sink ^= total;
  });
});

describe("PackedDeltaUint32List postings intersection", () => {
  const leftValues = arithmeticValues(262_144, 3);
  const rightValues = arithmeticValues(157_287, 5);
  const left = PackedDeltaUint32List.fromUint32Array(leftValues);
  const right = PackedDeltaUint32List.fromUint32Array(rightValues);
  const output = new Uint32Array(Math.min(left.length, right.length));

  afterAll(() => {
    right[Symbol.dispose]();
    left[Symbol.dispose]();
  });

  bench("PackedDelta intersectInto", () => {
    sink ^= left.intersectInto(right, output);
  });
  bench("Uint32Array intersection into", () => {
    sink ^= scalarIntersectionInto(leftValues, rightValues, output);
  });
});
