import { SharedBuffer } from "../../packages/jsimd/src/shared-buffer/mod.ts";
import { AggregateStateBlock } from "./aggregate_state.ts";
import { instantiateQueryKernels } from "./kernel.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertThrows(operation: () => unknown, constructor: typeof Error, message: string): void {
  try {
    operation();
  } catch (error) {
    if (error instanceof constructor) return;
    throw error;
  }
  throw new Error(message);
}

Deno.test("AggregateStateBlock merges SIMD groups and the scalar tail", async () => {
  using shared = await SharedBuffer.create();
  const kernels = await instantiateQueryKernels(shared.memory);
  const stride = AggregateStateBlock.byteLengthFor(5);
  const left = AggregateStateBlock.attach(shared, 0, 5);
  const right = AggregateStateBlock.attach(shared, stride, 5);
  const output = AggregateStateBlock.attach(shared, stride * 2, 5);

  left.reset();
  right.reset();
  output.reset();
  left.set(0, { count: 2, nullCount: 1, sum: 10n, min: 3, max: 7 });
  left.set(1, { count: 1, nullCount: 0, sum: -5n, min: -5, max: -5 });
  left.set(4, { count: 1, nullCount: 2, sum: 9n, min: 9, max: 9 });
  right.set(0, { count: 1, nullCount: 0, sum: -4n, min: -4, max: -4 });
  right.set(2, { count: 2, nullCount: 3, sum: 8n, min: 2, max: 6 });
  right.set(4, { count: 3, nullCount: 0, sum: 3n, min: 0, max: 2 });

  output.mergeFrom(left, kernels);
  output.mergeFrom(right, kernels);

  const first = output.at(0);
  assert(first.count === 3, "merged count");
  assert(first.nullCount === 1, "merged null count");
  assert(first.sum === 6n, "merged sum");
  assert(first.min === -4, "merged minimum");
  assert(first.max === 7, "merged maximum");
  assert(first.average === 2, "derived average");

  const empty = output.at(3);
  assert(empty.count === 0 && empty.nullCount === 0, "empty counts");
  assert(empty.sum === 0n, "empty sum");
  assert(empty.min === null && empty.max === null, "empty extrema");
  assert(empty.average === null, "empty average");

  const tail = output.at(4);
  assert(tail.count === 4, "scalar tail count");
  assert(tail.nullCount === 2, "scalar tail null count");
  assert(tail.sum === 12n, "scalar tail sum");
  assert(tail.min === 0 && tail.max === 9, "scalar tail extrema");
  assert(tail.average === 3, "scalar tail average");
});

Deno.test("AggregateStateBlock validates layout, state, and merge ownership", async () => {
  using shared = await SharedBuffer.create();
  const kernels = await instantiateQueryKernels(shared.memory);
  const stride = AggregateStateBlock.byteLengthFor(5);
  const block = AggregateStateBlock.attach(shared, 0, 5);
  const otherSize = AggregateStateBlock.attach(shared, stride, 4);

  assert(stride % 64 === 0, "blocks are cache-line aligned");
  assertThrows(() => AggregateStateBlock.byteLengthFor(0), RangeError, "positive group count");
  assertThrows(
    () => AggregateStateBlock.attach(shared, 4, 5),
    RangeError,
    "cache-line aligned offset",
  );
  assertThrows(
    () => AggregateStateBlock.attach(shared, shared.byteLength, 5),
    RangeError,
    "shared-memory bounds",
  );
  assertThrows(() => block.at(5), RangeError, "read index bounds");
  assertThrows(
    () => block.set(0, { count: 0, nullCount: 0, sum: 1n, min: null, max: null }),
    RangeError,
    "empty state sum",
  );
  assertThrows(
    () => block.set(0, { count: 1, nullCount: 0, sum: 1n, min: null, max: 1 }),
    TypeError,
    "non-empty extrema",
  );
  assertThrows(() => block.mergeFrom(block, kernels), RangeError, "aliasing merge");
  assertThrows(() => block.mergeFrom(otherSize, kernels), RangeError, "group-count mismatch");
  shared[Symbol.dispose]();
  assertThrows(() => block.at(0), Error, "disposed SharedBuffer lease");
});
