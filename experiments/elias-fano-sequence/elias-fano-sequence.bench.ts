import { afterAll, bench, describe } from "vitest";
import {
  EliasFanoSequence,
  PartitionedEliasFanoSequence,
} from "../../src/elias-fano-sequence/mod.ts";
import { PackedDeltaUint32List } from "../../src/packed-delta-uint32-list/mod.ts";

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

describe.each(
  [
    ["small deltas", arithmeticValues(262_144, 3)],
    ["variable deltas", variableDeltaValues(262_144)],
  ] as const,
)("EliasFanoSequence %s", (_name, values) => {
  const sequence = EliasFanoSequence.fromUint32Array(values);
  const packed = PackedDeltaUint32List.fromUint32Array(values);
  const indices = Uint32Array.from(
    { length: 1_024 },
    (_, index) => Math.imul(index + 17, 65_537) & (values.length - 1),
  );
  const queries = Uint32Array.from(indices, (index) => values[index]!);
  const pointOutput = new Uint32Array(indices.length);
  const rankOutput = new Uint32Array(queries.length);
  const decoded = new Uint32Array(values.length);

  afterAll(() => {
    packed[Symbol.dispose]();
    sequence[Symbol.dispose]();
  });

  bench("Elias-Fano atMany", () => {
    sequence.atMany(indices, pointOutput);
    sink ^= pointOutput[0]!;
  });
  bench("PackedDelta at x1024", () => {
    for (const index of indices) sink ^= packed.at(index);
  });
  bench("Uint32Array access x1024", () => {
    for (const index of indices) sink ^= values[index]!;
  });
  bench("Elias-Fano rankMany", () => {
    sequence.rankMany(queries, rankOutput);
    sink ^= rankOutput[0]!;
  });
  bench("PackedDelta lowerBound x1024", () => {
    for (const query of queries) sink ^= packed.lowerBound(query);
  });
  bench("Uint32Array lowerBound x1024", () => {
    for (const query of queries) sink ^= scalarLowerBound(values, query);
  });
  bench("Elias-Fano full decode", () => {
    sequence.decodeInto(decoded);
    sink ^= decoded[decoded.length - 1]!;
  });
  bench("PackedDelta full decode", () => {
    sink ^= packed.decodeInto(0, decoded);
  });
  bench("Uint32Array copy", () => {
    decoded.set(values);
    sink ^= decoded[decoded.length - 1]!;
  });
});

const clustered = Uint32Array.from({ length: 262_144 }, (_, index) => {
  const block = index >>> 8;
  return block * 1_000_000 + (index & 255);
});
describe("Partitioned Elias-Fano clustered monotone values", () => {
  const global = EliasFanoSequence.fromUint32Array(clustered);
  const partitioned = PartitionedEliasFanoSequence.fromUint32Array(clustered);
  const queries = Uint32Array.from(
    { length: 1_024 },
    (_, index) => clustered[Math.imul(index + 1, 65_537) & (clustered.length - 1)]!,
  );
  afterAll(() => {
    partitioned[Symbol.dispose]();
    global[Symbol.dispose]();
  });
  bench("partitioned rank x1024", () => {
    for (const query of queries) sink ^= partitioned.rank(query);
  });
  bench("global EF rank x1024", () => {
    for (const query of queries) sink ^= global.rank(query);
  });
  bench("Uint32Array lowerBound x1024", () => {
    for (const query of queries) sink ^= scalarLowerBound(clustered, query);
  });
});
