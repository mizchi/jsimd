import {
  layeredDependencyIds,
  layeredGraphStats,
  validateLayeredGraphShape,
} from "./layered_graph.ts";

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${message}: expected ${right}, got ${left}`);
}

function assertThrows(operation: () => unknown, constructor: typeof Error): void {
  try {
    operation();
  } catch (error) {
    if (error instanceof constructor) return;
    throw error;
  }
  throw new Error(`expected ${constructor.name}`);
}

Deno.test("layered graph stats separate width, depth, and packed memory", () => {
  assertEquals(
    layeredGraphStats({ width: 256, depth: 16, inputCount: 32, dependenciesPerNode: 4 }),
    {
      computedCount: 4_096,
      outputCount: 256,
      signalCount: 4_128,
      effectCount: 4_352,
      subscriptionCount: 16_640,
      denseSignalCount: 0,
      denseMatrixBytes: 0,
      fullDenseMatrixBytes: 2_245_632,
    },
    "balanced graph",
  );
});

Deno.test("layered graph dependency IDs are unique and deterministic", () => {
  assertEquals(layeredDependencyIds(32, 5, 4), [25, 28, 31, 2], "dependency IDs");
  assertEquals(layeredDependencyIds(6, 1, 4), [5, 2, 0, 3], "deduplicated cycle");
});

Deno.test("layered graph contract rejects invalid dimensions", () => {
  assertThrows(
    () => validateLayeredGraphShape({ width: 0, depth: 4, inputCount: 32, dependenciesPerNode: 4 }),
    RangeError,
  );
  assertThrows(
    () => validateLayeredGraphShape({ width: 4, depth: 0, inputCount: 32, dependenciesPerNode: 4 }),
    RangeError,
  );
  assertThrows(
    () => validateLayeredGraphShape({ width: 2, depth: 4, inputCount: 2, dependenciesPerNode: 3 }),
    RangeError,
  );
});
