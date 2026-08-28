import { SharedI32SelectionPipeline } from "./pipeline.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("shared selection composes predicates and reuses one generation across measures", async () => {
  const length = 777;
  const timestamp = Int32Array.from({ length }, (_, index) => index);
  const category = Int32Array.from({ length }, (_, index) => index & 7);
  const price = Int32Array.from({ length }, (_, index) => (index % 101) - 50);
  const quantity = Int32Array.from({ length }, (_, index) => index % 13);
  await using pipeline = await SharedI32SelectionPipeline.create([
    timestamp,
    category,
    price,
    quantity,
  ]);

  const selection = pipeline.selectBetween([
    { column: 0, minimum: 100, maximum: 700 },
    { column: 1, minimum: 3, maximum: 5 },
  ]);
  const actual = selection.aggregateMany([2, 3]);
  const expected = [price, quantity].map((measure) => {
    let count = 0;
    let sum = 0n;
    let min = 0x7fff_ffff;
    let max = -0x8000_0000;
    for (let row = 0; row < length; row++) {
      if (
        timestamp[row]! >= 100 && timestamp[row]! < 700 &&
        category[row]! >= 3 && category[row]! < 5
      ) {
        const value = measure[row]!;
        count++;
        sum += BigInt(value);
        if (value < min) min = value;
        if (value > max) max = value;
      }
    }
    return { count, sum, min: count === 0 ? 0 : min, max: count === 0 ? 0 : max };
  });

  assert(selection.selectedCount === expected[0]!.count, "selected count");
  for (let index = 0; index < expected.length; index++) {
    const left = actual[index]!;
    const right = expected[index]!;
    assert(left.count === right.count, `measure ${index} count`);
    assert(left.sum === right.sum, `measure ${index} sum`);
    assert(left.min === right.min, `measure ${index} min`);
    assert(left.max === right.max, `measure ${index} max`);
  }
});

Deno.test("shared selection handles empty results, tails, and stale generations", async () => {
  const values = Int32Array.of(-3, -2, -1, 0, 1, 2, 3);
  await using pipeline = await SharedI32SelectionPipeline.create([values]);
  const first = pipeline.selectBetween([{ column: 0, minimum: -2, maximum: 3 }]);
  assert(first.selectedCount === 5, "tail selection count");
  const firstAggregate = first.aggregate(0);
  assert(
    firstAggregate.sum === 0n && firstAggregate.min === -2 && firstAggregate.max === 2,
    "tail",
  );

  const empty = pipeline.selectBetween([{ column: 0, minimum: 10, maximum: 20 }]);
  assert(empty.selectedCount === 0, "empty selection count");
  const emptyAggregate = empty.aggregate(0);
  assert(
    emptyAggregate.count === 0 && emptyAggregate.sum === 0n &&
      emptyAggregate.min === 0 && emptyAggregate.max === 0,
    "empty aggregate",
  );
  try {
    first.aggregate(0);
  } catch (error) {
    assert(error instanceof Error && error.message.includes("stale"), "stale generation");
    return;
  }
  throw new Error("old selection generation must become stale");
});

Deno.test("shared selection matches scalar evaluation across SIMD boundaries", async () => {
  const lengths = [
    0,
    1,
    2,
    3,
    4,
    7,
    15,
    16,
    31,
    32,
    33,
    63,
    64,
    65,
    127,
    128,
    129,
    255,
    256,
    257,
    777,
  ];
  const ranges = [
    [-0x8000_0000, 0x7fff_ffff],
    [-100_000, 100_000],
    [-1, 1],
    [100, -100],
    [-0x8000_0000, -0x7fff_ffff],
    [0x7fff_ffff, 0x7fff_ffff],
  ] as const;

  for (const length of lengths) {
    const columns = Array.from(
      { length: 6 },
      (_, column) =>
        Int32Array.from({ length }, (_, row) => {
          if (row === 0) return -0x8000_0000;
          if (row === 1) return 0x7fff_ffff;
          return Math.imul(row + column * 97, 1_664_525 + column * 2) ^
            Math.imul(row ^ (column * 7919), 1_103_515_245);
        }),
    );
    await using pipeline = await SharedI32SelectionPipeline.create(columns);
    for (let round = 0; round < 8; round++) {
      const predicates = Array.from({ length: round & 3 }, (_, index) => {
        const [minimum, maximum] = ranges[(round + index * 3) % ranges.length]!;
        return { column: (round + index) % 3, minimum, maximum };
      });
      const selection = pipeline.selectBetween(predicates);
      const actual = selection.aggregateMany([3, 4, 5]);
      const selectedRows = Array.from({ length }, (_, row) => row).filter((row) =>
        predicates.every((predicate) => {
          const value = columns[predicate.column]![row]!;
          return value >= predicate.minimum && value < predicate.maximum;
        })
      );
      assert(selection.selectedCount === selectedRows.length, "randomized selected count");
      for (let measure = 0; measure < 3; measure++) {
        let sum = 0n;
        let min = 0x7fff_ffff;
        let max = -0x8000_0000;
        for (const row of selectedRows) {
          const value = columns[measure + 3]![row]!;
          sum = BigInt.asIntN(64, sum + BigInt(value));
          if (value < min) min = value;
          if (value > max) max = value;
        }
        const aggregate = actual[measure]!;
        assert(aggregate.count === selectedRows.length, "randomized aggregate count");
        assert(aggregate.sum === sum, "randomized aggregate sum");
        assert(aggregate.min === (selectedRows.length === 0 ? 0 : min), "randomized minimum");
        assert(aggregate.max === (selectedRows.length === 0 ? 0 : max), "randomized maximum");
      }
    }
  }
});
