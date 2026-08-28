import { SharedBuffer } from "../../packages/jsimd/src/shared-buffer/mod.ts";
import { instantiateQueryKernels } from "./kernel.ts";
import { LocalGroupHashTableU32, localGroupHashU32 } from "./local_group_hash_table.ts";
import { LocalGroupHashWorkerPool } from "./local_group_hash_worker_pool.ts";
import { SparseU32GroupByQuery } from "./sparse_group_by.ts";

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

Deno.test("LocalGroupHashTableU32 aggregates resident nullable i32 measures", async () => {
  using shared = await SharedBuffer.create();
  const kernels = await instantiateQueryKernels(shared.memory);
  const table = LocalGroupHashTableU32.initialize(shared, 0, 16);
  const inputOffset = table.byteLength;
  const keysOffset = inputOffset;
  const valuesOffset = keysOffset + 8 * 4;
  const validitiesOffset = valuesOffset + 8 * 4;
  shared.uint32Array(keysOffset, 8).set([7, 7, 7, 0xffff_ffff, 0, 23, 23, 23]);
  shared.int32Array(valuesOffset, 8).set([5, -2, 100, 9, -4, 8, 3, -1]);
  shared.uint8Array(validitiesOffset, 8).set([1, 1, 0, 1, 1, 1, 1, 1]);

  table.aggregateResident(
    keysOffset,
    valuesOffset,
    validitiesOffset,
    8,
    kernels,
  );
  table.add(7, 11, kernels);
  table.add(7, null, kernels);

  assert(table.size === 4, "distinct group count");
  const seven = table.get(7, kernels)!;
  assert(seven.count === 3, "non-null count");
  assert(seven.nullCount === 2, "null count");
  assert(seven.sum === 14n, "signed sum");
  assert(seven.min === -2 && seven.max === 11, "extrema");
  assert(seven.average === 14 / 3, "derived average");
  const twentyThree = table.get(23, kernels)!;
  assert(twentyThree.count === 3 && twentyThree.sum === 10n, "duplicate key aggregate");
  assert(twentyThree.min === -1 && twentyThree.max === 8, "duplicate extrema");
  assert(table.get(123, kernels) === undefined, "missing key");

  const attached = LocalGroupHashTableU32.attach(shared, 0);
  assert(attached.get(0xffff_ffff, kernels)?.sum === 9n, "complete u32 key domain");
  assert(attached.entries().length === 4, "attached table observes entries");
});

Deno.test("LocalGroupHashTableU32 filters resident rows before sparse grouping", async () => {
  using shared = await SharedBuffer.create();
  const kernels = await instantiateQueryKernels(shared.memory);
  const table = LocalGroupHashTableU32.initialize(shared, 0, 16);
  const filterOffset = table.byteLength;
  const keysOffset = filterOffset + 7 * 4;
  const valuesOffset = keysOffset + 7 * 4;
  const validitiesOffset = valuesOffset + 7 * 4;
  shared.int32Array(filterOffset, 7).set([-3, 0, 4, 5, 9, 10, 11]);
  shared.uint32Array(keysOffset, 7).set([99, 7, 7, 8, 8, 9, 10]);
  shared.int32Array(valuesOffset, 7).set([100, 2, 3, 4, 5, 6, 7]);
  shared.uint8Array(validitiesOffset, 7).set([1, 1, 0, 1, 1, 1, 1]);

  table.aggregateResidentBetween(
    filterOffset,
    keysOffset,
    valuesOffset,
    validitiesOffset,
    7,
    0,
    10,
    kernels,
  );

  assert(table.size === 2, "only selected keys are materialized");
  const seven = table.get(7, kernels)!;
  assert(seven.count === 1 && seven.nullCount === 1, "selected null state");
  assert(seven.sum === 2n && seven.min === 2 && seven.max === 2, "selected key seven");
  const eight = table.get(8, kernels)!;
  assert(eight.count === 2 && eight.sum === 9n, "SIMD boundary and scalar tail");
  assert(table.get(9, kernels) === undefined, "exclusive upper bound");
});

Deno.test("LocalGroupHashTableU32 merges disjoint owner radix partitions", async () => {
  using shared = await SharedBuffer.create({ initialPages: 2 });
  const kernels = await instantiateQueryKernels(shared.memory);
  const stride = LocalGroupHashTableU32.byteLengthFor(32);
  const left = LocalGroupHashTableU32.initialize(shared, 0, 32);
  const right = LocalGroupHashTableU32.initialize(shared, stride, 32);
  const outputs = Array.from(
    { length: 4 },
    (_, partition) => LocalGroupHashTableU32.initialize(shared, stride * (partition + 2), 32),
  );
  for (const [key, value] of [[1, 10], [2, 20], [3, -5], [1000, 7]] as const) {
    left.add(key, value, kernels);
  }
  for (const [key, value] of [[2, 4], [3, 8], [4, 9], [1000, -2]] as const) {
    right.add(key, value, kernels);
  }

  outputs.forEach((output, partition) => {
    output.mergePartitionFrom(left, partition, 4, kernels);
    output.mergePartitionFrom(right, partition, 4, kernels);
  });

  const entries = outputs.flatMap((output) => output.entries()).sort((a, b) => a.key - b.key);
  assert(entries.length === 5, "merged distinct groups");
  for (const entry of entries) {
    const partition = localGroupHashU32(entry.key) & 3;
    assert(outputs[partition]!.get(entry.key, kernels) !== undefined, "partition owns key");
    outputs.forEach((output, index) => {
      if (index !== partition) {
        assert(output.get(entry.key, kernels) === undefined, "non-owner excludes key");
      }
    });
  }
  const two = outputs[localGroupHashU32(2) & 3]!.get(2, kernels)!;
  assert(two.count === 2 && two.sum === 24n, "overlapping key state merge");
  assert(two.min === 4 && two.max === 20, "overlapping key extrema");
  const thousand = outputs[localGroupHashU32(1000) & 3]!.get(1000, kernels)!;
  assert(thousand.count === 2 && thousand.sum === 5n, "second overlapping key");
});

Deno.test("LocalGroupHashWorkerPool builds and merges owner partitions", async () => {
  using shared = await SharedBuffer.create({ maxWorkers: 3 });
  const stride = LocalGroupHashTableU32.byteLengthFor(16);
  const partials = [
    LocalGroupHashTableU32.initialize(shared, 0, 16),
    LocalGroupHashTableU32.initialize(shared, stride, 16),
  ];
  const outputs = [
    LocalGroupHashTableU32.initialize(shared, stride * 2, 16),
    LocalGroupHashTableU32.initialize(shared, stride * 3, 16),
  ];
  const keysOffset = stride * 4;
  const valuesOffset = keysOffset + 8 * 4;
  const validitiesOffset = valuesOffset + 8 * 4;
  shared.uint32Array(keysOffset, 8).set([1, 2, 1, 3, 2, 4, 3, 4]);
  shared.int32Array(valuesOffset, 8).set([10, 20, -2, 7, 4, 9, 8, -1]);
  shared.uint8Array(validitiesOffset, 8).set([1, 1, 1, 0, 1, 1, 1, 1]);
  const pool = await LocalGroupHashWorkerPool.create(shared, partials, outputs, {
    keysByteOffset: keysOffset,
    valuesByteOffset: valuesOffset,
    validitiesByteOffset: validitiesOffset,
    rowCount: 8,
  });
  await pool.aggregate();
  const entries = outputs.flatMap((table) => table.entries());
  assert(entries.length === 4, "Worker output group count");
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  assert(byKey.get(1)?.sum === 8n, "Worker key one");
  assert(byKey.get(2)?.sum === 24n, "Worker key two");
  assert(byKey.get(3)?.count === 1 && byKey.get(3)?.nullCount === 1, "Worker null state");
  assert(byKey.get(4)?.min === -1 && byKey.get(4)?.max === 9, "Worker extrema");
  await pool[Symbol.asyncDispose]();
  await pool[Symbol.asyncDispose]();
  try {
    await pool.aggregate();
  } catch (error) {
    assert(error instanceof Error && error.message.includes("disposed"), "disposed Worker pool");
    return;
  }
  throw new Error("disposed Worker pool must reject aggregation");
});

Deno.test("LocalGroupHashWorkerPool prunes pages before filtered sparse grouping", async () => {
  using shared = await SharedBuffer.create({ maxWorkers: 3 });
  const stride = LocalGroupHashTableU32.byteLengthFor(16);
  const partials = [
    LocalGroupHashTableU32.initialize(shared, 0, 16),
    LocalGroupHashTableU32.initialize(shared, stride, 16),
  ];
  const outputs = [
    LocalGroupHashTableU32.initialize(shared, stride * 2, 16),
    LocalGroupHashTableU32.initialize(shared, stride * 3, 16),
  ];
  const filterOffset = stride * 4;
  const keysOffset = filterOffset + 12 * 4;
  const valuesOffset = keysOffset + 12 * 4;
  const validitiesOffset = valuesOffset + 12 * 4;
  shared.int32Array(filterOffset, 12).set([
    0,
    1,
    2,
    3,
    100,
    101,
    102,
    103,
    200,
    201,
    202,
    203,
  ]);
  shared.uint32Array(keysOffset, 12).set([1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6]);
  shared.int32Array(valuesOffset, 12).set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  shared.uint8Array(validitiesOffset, 12).fill(1);
  await using pool = await LocalGroupHashWorkerPool.create(shared, partials, outputs, {
    filterByteOffset: filterOffset,
    keysByteOffset: keysOffset,
    valuesByteOffset: valuesOffset,
    validitiesByteOffset: validitiesOffset,
    rowCount: 12,
    pageRows: 4,
  });

  const result = await pool.aggregateBetween(100, 103);
  assert(result.pagesScanned === 1, "one overlapping page is scanned");
  assert(result.pagesSkipped === 2, "two pages are pruned by zone maps");
  const entries = outputs.flatMap((table) => table.entries());
  assert(entries.length === 2, "only selected sparse keys are present");
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  assert(byKey.get(3)?.sum === 11n, "lower selected key aggregate");
  assert(byKey.get(4)?.sum === 7n, "exclusive upper bound");
});

Deno.test("SparseU32GroupByQuery keeps single and Worker result contracts identical", async () => {
  const filter = new Int32Array(16);
  const keys = new Uint32Array(16);
  const values = new Int32Array(16);
  const validities = new Uint8Array(16).fill(1);
  for (let row = 0; row < 16; row++) {
    filter[row] = row;
    keys[row] = Math.imul(row & 3, 0x9e37_79b1) >>> 0;
    values[row] = row - 8;
  }
  validities[6] = 0;
  const columns = { filter, keys, values, validities };
  await using single = await SparseU32GroupByQuery.create(columns, {
    capacity: 16,
    workerCount: 1,
    pageRows: 4,
  });
  await using parallel = await SparseU32GroupByQuery.create(columns, {
    capacity: 16,
    workerCount: 2,
    pageRows: 4,
  });

  const left = await single.aggregateBetween(4, 12);
  const right = await parallel.aggregateBetween(4, 12);
  assert(JSON.stringify(left, bigintReplacer) === JSON.stringify(right, bigintReplacer), "results");
  assert(left.pagesScanned === 2 && left.pagesSkipped === 2, "page statistics");
});

Deno.test("LocalGroupHashTableU32 validates capacity, ownership, and lifetime", async () => {
  const shared = await SharedBuffer.create();
  const kernels = await instantiateQueryKernels(shared.memory);
  const stride = LocalGroupHashTableU32.byteLengthFor(16);
  const table = LocalGroupHashTableU32.initialize(shared, 0, 16);
  const other = LocalGroupHashTableU32.initialize(shared, stride, 16);
  assertThrows(() => LocalGroupHashTableU32.byteLengthFor(15), RangeError, "power-of-two capacity");
  assertThrows(
    () => LocalGroupHashTableU32.initialize(shared, 4, 16),
    RangeError,
    "cache-line offset",
  );
  assertThrows(
    () => LocalGroupHashTableU32.attach(shared, stride * 2),
    RangeError,
    "uninitialized table",
  );
  for (let key = 0; key < 14; key++) table.add(key, key, kernels);
  assertThrows(() => table.add(14, 14, kernels), RangeError, "load-factor limit");
  assert(table.size === 14, "overflow preserves existing size");
  assertThrows(
    () => table.mergePartitionFrom(table, 0, 2, kernels),
    RangeError,
    "source and destination alias",
  );
  assertThrows(
    () => table.mergePartitionFrom(other, 2, 2, kernels),
    RangeError,
    "partition bounds",
  );
  shared[Symbol.dispose]();
  assertThrows(() => table.entries(), Error, "disposed backing lease");
});

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? String(value) : value;
}
