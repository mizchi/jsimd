import { complexTreeStats, createComplexTreePlan, dependencyIds } from "./complex_tree.ts";

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

Deno.test("complex tree plan is balanced and preserves every leaf", () => {
  assertEquals(
    complexTreeStats(createComplexTreePlan(64)),
    { leaves: 64, branches: 21, maxDepth: 3 },
    "64-leaf tree",
  );
  assertEquals(
    complexTreeStats(createComplexTreePlan(1_024)),
    { leaves: 1_024, branches: 341, maxDepth: 5 },
    "1024-leaf tree",
  );
});

Deno.test("complex tree distributes unique dependencies deterministically", () => {
  assertEquals(dependencyIds(32, 5, 2, 4), [7, 18, 29, 8], "dependency IDs");
  assertEquals(dependencyIds(32, 5, 2, 4), dependencyIds(32, 5, 2, 4), "stable IDs");
});

Deno.test("complex tree contract rejects shapes that cannot be balanced", () => {
  assertThrows(() => createComplexTreePlan(0), RangeError);
  assertThrows(() => createComplexTreePlan(63), RangeError);
  assertThrows(() => dependencyIds(3, 0, 0, 4), RangeError);
});
