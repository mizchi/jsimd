import { ParallelI32Query, type ScanAggregate, scanBetweenReference } from "./mod.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertAggregate(
  actual: ScanAggregate,
  expected: ScanAggregate,
  message: string,
): void {
  assert(actual.count === expected.count, `${message}: count ${actual.count}`);
  assert(actual.sum === expected.sum, `${message}: sum ${actual.sum}`);
}

Deno.test("ParallelI32Query agrees with the scalar contract across repeated queries", async () => {
  const values = Int32Array.from(
    { length: 4_103 },
    (_, index) => ((Math.imul(index, 1_103_515_245) + 12_345) >> 19) - 4_096,
  );
  await using query = await ParallelI32Query.create(values, {
    workerCount: 4,
    pageRows: 256,
  });

  for (
    const [minimum, maximum] of [
      [-4_096, 4_096],
      [-500, 500],
      [0, 1],
      [2_000, 2_000],
      [5_000, 6_000],
    ] as const
  ) {
    const expected = scanBetweenReference(values, minimum, maximum);
    assertAggregate(await query.scanBetween(minimum, maximum), expected, `${minimum}..<${maximum}`);
    assertAggregate(
      query.scanBetweenSingleThread(minimum, maximum),
      expected,
      `single ${minimum}..<${maximum}`,
    );
  }
});

Deno.test("ParallelI32Query skips row-group pages using immutable zone maps", async () => {
  const values = new Int32Array(1_024);
  for (let index = 0; index < values.length; index++) values[index] = index;
  await using query = await ParallelI32Query.create(values, {
    workerCount: 2,
    pageRows: 128,
  });

  const result = await query.scanBetween(300, 340);
  assertAggregate(result, { count: 40, sum: 12_780n, pagesScanned: 1 }, "zone-mapped result");
  assert(result.pagesScanned === 1, "only the intersecting page should be scanned");
  assert(result.pagesSkipped === 7, "all disjoint pages should be skipped");
});

Deno.test("ParallelI32Query validates its query and lifetime contracts", async () => {
  const query = await ParallelI32Query.create(new Int32Array([1, 2, 3]), {
    workerCount: 1,
    pageRows: 4,
  });
  await query[Symbol.asyncDispose]();
  await query[Symbol.asyncDispose]();
  try {
    await query.scanBetween(0, 4);
  } catch (error) {
    assert(error instanceof Error && error.message.includes("disposed"), "disposed query error");
    return;
  }
  throw new Error("disposed query must reject scans");
});

Deno.test("ParallelI32Query publishes immutable replacement generations", async () => {
  await using query = await ParallelI32Query.create(new Int32Array([1, 2, 3, 4, 5, 6]), {
    workerCount: 2,
    pageRows: 2,
  });
  const initialGeneration = query.generation;
  assertAggregate(await query.scanBetween(2, 6), { count: 4, sum: 14n }, "initial snapshot");

  const generation = query.replace(new Int32Array([10, 20, 30, 40, 50, 60]));
  assert(generation > initialGeneration, "replacement publishes a newer generation");
  assert(query.generation === generation, "generation getter observes publication");
  assertAggregate(await query.scanBetween(20, 60), { count: 4, sum: 140n }, "replacement snapshot");
});

Deno.test("ParallelI32Query cancels at page boundaries and remains reusable", async () => {
  const values = new Int32Array(1 << 20);
  for (let index = 0; index < values.length; index++) values[index] = index & 1023;
  await using query = await ParallelI32Query.create(values, {
    workerCount: 4,
    pageRows: 256,
  });

  const pending = query.scanBetween(0, 1024);
  assert(query.cancelCurrent(), "active query cancellation is published");
  try {
    await pending;
  } catch (error) {
    assert(error instanceof DOMException && error.name === "AbortError", "AbortError contract");
    assertAggregate(
      await query.scanBetween(0, 1),
      scanBetweenReference(values, 0, 1),
      "query remains reusable",
    );
    return;
  }
  throw new Error("cancelled query must reject");
});

Deno.test("ParallelI32Query restarts its Worker pool without losing the snapshot", async () => {
  const values = Int32Array.from({ length: 8_192 }, (_, index) => index - 4_096);
  await using query = await ParallelI32Query.create(values, {
    workerCount: 3,
    pageRows: 128,
  });
  const generation = query.generation;
  await query.restartWorkers();
  assert(query.generation === generation, "restart preserves snapshot generation");
  const restartedResult = await query.scanBetween(-100, 100);
  assertAggregate(
    restartedResult,
    scanBetweenReference(values, -100, 100),
    "restarted Workers",
  );
});
