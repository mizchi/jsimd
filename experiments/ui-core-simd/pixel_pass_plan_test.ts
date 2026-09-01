import { createPixelPassPlan, PIXEL_WORKGROUP_SIZE } from "./pixel_pass_plan.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

Deno.test("pixel GPU pass plan covers the same disjoint pairs as the CPU contract", () => {
  assertEquals(createPixelPassPlan(8, 6, 0), {
    parity: 0,
    verticalPairs: 24,
    diagonalPairs: 20,
    horizontalPairs: 24,
    verticalWorkgroups: Math.ceil(24 / PIXEL_WORKGROUP_SIZE),
    diagonalWorkgroups: Math.ceil(20 / PIXEL_WORKGROUP_SIZE),
    horizontalWorkgroups: Math.ceil(24 / PIXEL_WORKGROUP_SIZE),
  });
  assertEquals(createPixelPassPlan(8, 6, 1), {
    parity: 1,
    verticalPairs: 16,
    diagonalPairs: 15,
    horizontalPairs: 18,
    verticalWorkgroups: Math.ceil(16 / PIXEL_WORKGROUP_SIZE),
    diagonalWorkgroups: Math.ceil(15 / PIXEL_WORKGROUP_SIZE),
    horizontalWorkgroups: Math.ceil(18 / PIXEL_WORKGROUP_SIZE),
  });
});

Deno.test("pixel GPU pass plan validates dimensions and phase", () => {
  let errors = 0;
  for (
    const invoke of [
      () => createPixelPassPlan(0, 1, 0),
      () => createPixelPassPlan(1, 1, -1),
    ]
  ) {
    try {
      invoke();
    } catch (error) {
      if (error instanceof RangeError) errors++;
    }
  }
  assertEquals(errors, 2);
});
