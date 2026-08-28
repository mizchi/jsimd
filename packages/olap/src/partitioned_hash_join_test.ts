import { SharedBuffer } from "@mizchi/jsimd-shared";
import { instantiateQueryKernels } from "./kernel.ts";
import { PartitionedHashJoinTableU32 } from "./partitioned_hash_join.ts";
import { PartitionedHashJoinWorkerPool } from "./partitioned_hash_join_worker_pool.ts";

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

Deno.test("PartitionedHashJoinTableU32 preserves duplicate build order", async () => {
  using shared = await SharedBuffer.create({ initialPages: 2, maximumPages: 2 });
  const kernels = await instantiateQueryKernels(shared.memory);
  const table = PartitionedHashJoinTableU32.initialize(shared, 0, {
    partitionCount: 4,
    capacityPerPartition: 16,
    maxBuildRows: 16,
    bloomBitsPerKey: 10,
  });
  const buildKeysOffset = table.byteLength;
  const buildRowsOffset = buildKeysOffset + 6 * 4;
  const probeKeysOffset = buildRowsOffset + 6 * 4;
  const probeRowsOffset = probeKeysOffset + 4 * 4;
  const outputProbeOffset = probeRowsOffset + 4 * 4;
  const outputBuildOffset = outputProbeOffset + 7 * 4;
  shared.uint32Array(buildKeysOffset, 6).set([7, 9, 7, 7, 100, 0xffff_ffff]);
  shared.uint32Array(buildRowsOffset, 6).set([10, 11, 12, 13, 14, 15]);
  shared.uint32Array(probeKeysOffset, 4).set([7, 8, 100, 7]);
  shared.uint32Array(probeRowsOffset, 4).set([20, 21, 22, 23]);

  table.buildResident(buildKeysOffset, buildRowsOffset, 6, kernels);
  const count = table.countMatchesResident(probeKeysOffset, 4, kernels);
  assert(count.matchCount === 7, "duplicate join cardinality");
  assert(count.bloomRejected === 1, "Bloom rejects the absent probe row");
  const result = table.probeResident(
    probeKeysOffset,
    probeRowsOffset,
    4,
    outputProbeOffset,
    outputBuildOffset,
    7,
    kernels,
  );
  assert(result.matchCount === 7 && result.written === 7 && !result.truncated, "full output");
  assert(
    shared.uint32Array(outputProbeOffset, 7).join(",") === "20,20,20,22,23,23,23",
    "probe-major output order",
  );
  assert(
    shared.uint32Array(outputBuildOffset, 7).join(",") === "10,12,13,14,10,12,13",
    "build input order within duplicate chains",
  );
  assert(table.buildRows === 6 && table.distinctKeys === 4, "table state");
  const attached = PartitionedHashJoinTableU32.attach(shared, 0);
  assert(attached.countMatchesResident(probeKeysOffset, 4, kernels).matchCount === 7, "attach");
});

Deno.test("PartitionedHashJoinTableU32 reports caller output exhaustion", async () => {
  using shared = await SharedBuffer.create({ initialPages: 2, maximumPages: 2 });
  const kernels = await instantiateQueryKernels(shared.memory);
  const table = PartitionedHashJoinTableU32.initialize(shared, 0, {
    partitionCount: 2,
    capacityPerPartition: 16,
    maxBuildRows: 8,
    bloomBitsPerKey: 0,
  });
  const buildKeysOffset = table.byteLength;
  const buildRowsOffset = buildKeysOffset + 4 * 4;
  const probeKeysOffset = buildRowsOffset + 4 * 4;
  const probeRowsOffset = probeKeysOffset + 2 * 4;
  const outputProbeOffset = probeRowsOffset + 2 * 4;
  const outputBuildOffset = outputProbeOffset + 3 * 4;
  shared.uint32Array(buildKeysOffset, 4).set([1, 1, 1, 2]);
  shared.uint32Array(buildRowsOffset, 4).set([0, 1, 2, 3]);
  shared.uint32Array(probeKeysOffset, 2).set([1, 1]);
  shared.uint32Array(probeRowsOffset, 2).set([8, 9]);
  table.buildResident(buildKeysOffset, buildRowsOffset, 4, kernels);

  const result = table.probeResident(
    probeKeysOffset,
    probeRowsOffset,
    2,
    outputProbeOffset,
    outputBuildOffset,
    3,
    kernels,
  );
  assert(result.matchCount === 6 && result.written === 3 && result.truncated, "truncation");
  assert(shared.uint32Array(outputBuildOffset, 3).join(",") === "0,1,2", "stable prefix");
  table.clear();
  assert(table.buildRows === 0 && table.distinctKeys === 0, "clear state");
});

Deno.test("PartitionedHashJoinWorkerPool writes ordered disjoint output shards", async () => {
  using shared = await SharedBuffer.create({
    initialPages: 2,
    maximumPages: 2,
    maxWorkers: 3,
  });
  const kernels = await instantiateQueryKernels(shared.memory);
  const table = PartitionedHashJoinTableU32.initialize(shared, 0, {
    partitionCount: 2,
    capacityPerPartition: 16,
    maxBuildRows: 8,
    bloomBitsPerKey: 10,
  });
  const buildKeysOffset = table.byteLength;
  const buildRowsOffset = buildKeysOffset + 4 * 4;
  const probeKeysOffset = buildRowsOffset + 4 * 4;
  const probeRowsOffset = probeKeysOffset + 4 * 4;
  const firstProbeOutput = probeRowsOffset + 4 * 4;
  const firstBuildOutput = firstProbeOutput + 4 * 4;
  const secondProbeOutput = firstBuildOutput + 4 * 4;
  const secondBuildOutput = secondProbeOutput + 4 * 4;
  shared.uint32Array(buildKeysOffset, 4).set([1, 1, 2, 3]);
  shared.uint32Array(buildRowsOffset, 4).set([10, 11, 12, 13]);
  shared.uint32Array(probeKeysOffset, 4).set([1, 9, 2, 1]);
  shared.uint32Array(probeRowsOffset, 4).set([20, 21, 22, 23]);
  table.buildResident(buildKeysOffset, buildRowsOffset, 4, kernels);
  await using pool = await PartitionedHashJoinWorkerPool.create(
    shared,
    table,
    { keysByteOffset: probeKeysOffset, rowIdsByteOffset: probeRowsOffset, rowCount: 4 },
    [
      {
        probeRowIdsByteOffset: firstProbeOutput,
        buildRowIdsByteOffset: firstBuildOutput,
        capacity: 4,
      },
      {
        probeRowIdsByteOffset: secondProbeOutput,
        buildRowIdsByteOffset: secondBuildOutput,
        capacity: 4,
      },
    ],
  );
  const result = await pool.probe();
  assert(result.matchCount === 5 && result.written === 5 && !result.truncated, "Worker result");
  assert(shared.uint32Array(firstProbeOutput, 2).join(",") === "20,20", "first shard probes");
  assert(shared.uint32Array(firstBuildOutput, 2).join(",") === "10,11", "first shard builds");
  assert(shared.uint32Array(secondProbeOutput, 3).join(",") === "22,23,23", "second shard probes");
  assert(shared.uint32Array(secondBuildOutput, 3).join(",") === "12,10,11", "second shard builds");
});

Deno.test("PartitionedHashJoinTableU32 validates layout, capacity, and lifetime", async () => {
  const shared = await SharedBuffer.create({ initialPages: 2, maximumPages: 2 });
  const kernels = await instantiateQueryKernels(shared.memory);
  assertThrows(
    () =>
      PartitionedHashJoinTableU32.initialize(shared, 4, {
        partitionCount: 1,
        capacityPerPartition: 16,
        maxBuildRows: 16,
      }),
    RangeError,
    "cache-line table alignment",
  );
  const table = PartitionedHashJoinTableU32.initialize(shared, 0, {
    partitionCount: 1,
    capacityPerPartition: 16,
    maxBuildRows: 16,
  });
  const keysOffset = table.byteLength;
  const rowsOffset = keysOffset + 15 * 4;
  shared.uint32Array(keysOffset, 15).set(Array.from({ length: 15 }, (_, index) => index));
  shared.uint32Array(rowsOffset, 15).set(Array.from({ length: 15 }, (_, index) => index));
  assertThrows(
    () => table.buildResident(keysOffset, rowsOffset, 15, kernels),
    RangeError,
    "7/8 load factor",
  );
  shared[Symbol.dispose]();
  assertThrows(() => table.clear(), Error, "disposed backing lease");
});
