import { PdxBlockPruningExperiment } from "./pdx_block_pruning.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("block-pruned PDX remains exact while skipping separated vector pages", async () => {
  const count = 260;
  const dimensions = 7;
  const values = new Float32Array(count * dimensions);
  for (let row = 0; row < count; row++) {
    const block = row >>> 6;
    for (let dimension = 0; dimension < dimensions; dimension++) {
      values[row * dimensions + dimension] = block * 40 + (row & 63) * 0.002 + dimension * 0.01;
    }
  }
  using index = await PdxBlockPruningExperiment.create(values, dimensions, { maxK: 10 });
  const query = values.slice(3 * dimensions, 4 * dimensions);
  const exact = index.searchExact(query, 10);
  const pruned = index.searchPruned(query, 10);

  assert(pruned.ids.join(",") === exact.ids.join(","), "exact IDs");
  assert(pruned.distances.join(",") === exact.distances.join(","), "exact distances");
  assert(pruned.prunedBlocks >= 4, `pruned blocks: ${pruned.prunedBlocks}`);
  assert(pruned.evaluatedRows < count / 2, `evaluated rows: ${pruned.evaluatedRows}`);
  assert(index.metadataBytes === Math.ceil(count / 64) * dimensions * 8, "metadata size");
});

Deno.test("block-pruning experiment validates finite fixed-width inputs and lifetime", async () => {
  await assertRejects(() => PdxBlockPruningExperiment.create(new Float32Array(5), 2));
  await assertRejects(() => PdxBlockPruningExperiment.create(new Float32Array([0, Number.NaN]), 2));
  const index = await PdxBlockPruningExperiment.create(new Float32Array(16), 4, { maxK: 2 });
  assertThrows(() => index.searchPruned(new Float32Array(3), 1));
  assertThrows(() => index.searchPruned(new Float32Array(4), 3));
  index[Symbol.dispose]();
  assertThrows(() => index.searchExact(new Float32Array(4), 1));
});

Deno.test("block pruning matches full PDX across randomized block tails", async () => {
  const count = 513;
  const dimensions = 13;
  const values = new Float32Array(count * dimensions);
  let state = 0x1234_5678;
  for (let index = 0; index < values.length; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    values[index] = (state / 0xffff_ffff - 0.5) * 20;
  }
  using index = await PdxBlockPruningExperiment.create(values, dimensions, { maxK: 17 });
  for (const row of [0, 63, 64, 255, 512]) {
    const query = values.slice(row * dimensions, (row + 1) * dimensions);
    const exact = index.searchExact(query, 17);
    const pruned = index.searchPruned(query, 17);
    assert(pruned.ids.join(",") === exact.ids.join(","), `row ${row}: IDs`);
    assert(pruned.distances.join(",") === exact.distances.join(","), `row ${row}: distances`);
  }
});

function assertThrows(operation: () => unknown): void {
  try {
    operation();
  } catch {
    return;
  }
  throw new Error("expected operation to throw");
}

async function assertRejects(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error("expected operation to reject");
}
