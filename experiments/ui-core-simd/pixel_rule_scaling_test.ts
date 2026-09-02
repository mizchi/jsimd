import { planPixelRuleBuffers, recommendPixelEventCapacity } from "./pixel_rule_scaling.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`expected ${expected}, got ${actual}`);
}

Deno.test("pixel rule buffers keep material and rule metadata independent of cell count", () => {
  const plan = planPixelRuleBuffers({
    width: 512,
    height: 320,
    materialCount: 64,
    ruleCount: 32,
    eventCapacity: 256,
    fields: [
      { bytesPerCell: 1, buffers: 2 },
      { bytesPerCell: 2, buffers: 1 },
    ],
  });
  assertEquals(plan.cellBytes, 655_360);
  assertEquals(plan.sharedScratchBytes, 655_360);
  assertEquals(plan.materialTableBytes, 1_024);
  assertEquals(plan.ruleTableBytes, 512);
  assertEquals(plan.fieldBytes, 655_360);
  assertEquals(plan.wasmEventBytes, 4_096);
  assertEquals(plan.sharedEventBytes, 4_128);
  assertEquals(plan.mainEventDrainBytes, 4_096);
  assertEquals(plan.activeChunkBytes, 480);
  assertEquals(plan.wasmBytes, 1_971_712);
  assertEquals(plan.wasmRoundedBytes, 2_031_616);
  assertEquals(plan.totalOwnedBytes, 2_695_680);
});

Deno.test("pixel event capacity covers a bounded burst across consumer lag", () => {
  assertEquals(recommendPixelEventCapacity(100, 1, 1.5), 256);
  assertEquals(recommendPixelEventCapacity(600, 2, 1.5), 2_048);
  assertEquals(recommendPixelEventCapacity(0, 4, 2), 2);
});

Deno.test("pixel rule buffer planner rejects unsupported material IDs and fields", () => {
  let errors = 0;
  for (
    const invoke of [
      () =>
        planPixelRuleBuffers({
          width: 512,
          height: 320,
          materialCount: 257,
          ruleCount: 1,
          eventCapacity: 256,
          fields: [],
        }),
      () =>
        planPixelRuleBuffers({
          width: 512,
          height: 320,
          materialCount: 8,
          ruleCount: 1,
          eventCapacity: 256,
          fields: [{ bytesPerCell: 3 as 1, buffers: 1 }],
        }),
      () => recommendPixelEventCapacity(100, 0, 1.5),
    ]
  ) {
    try {
      invoke();
    } catch (error) {
      if (error instanceof RangeError) errors++;
    }
  }
  assertEquals(errors, 3);
});
