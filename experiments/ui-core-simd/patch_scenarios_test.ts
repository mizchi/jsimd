import {
  createPatchScenarioPlan,
  PATCH_SCENARIOS,
  projectPatchScenarioValue,
  updatePatchScenarioValue,
} from "./patch_scenarios.ts";

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${message}: expected ${right}, got ${left}`);
}

Deno.test("patch scenario matrix separates density, batching, and stable output", () => {
  assertEquals(
    PATCH_SCENARIOS.map((scenario) => scenario.id),
    [
      "sparse-batched",
      "quarter-batched",
      "dense-batched",
      "dense-simd-batched",
      "dense-unbatched",
      "dense-stable",
    ],
    "scenario IDs",
  );

  const plans = PATCH_SCENARIOS.map((scenario) => createPatchScenarioPlan(4_096, scenario));
  assertEquals(
    plans.map((plan) => [plan.affectedBindingCount, plan.flushCount, plan.expectedPatchCount]),
    [
      [64, 1, 64],
      [1_024, 1, 1_024],
      [4_096, 1, 4_096],
      [4_096, 1, 4_096],
      [4_096, 64, 4_096],
      [4_096, 1, 0],
    ],
    "scenario costs",
  );
});

Deno.test("patch scenario plans distribute bindings evenly over source signals", () => {
  const plan = createPatchScenarioPlan(512, PATCH_SCENARIOS[0]!);
  const counts = new Uint32Array(plan.signalCount);
  for (const signalId of plan.sourceByBinding) counts[signalId]++;
  assertEquals([...counts], Array.from({ length: 64 }, () => 8), "source distribution");
  assertEquals([...plan.changedSignalIds], [0], "sparse changed signal");
});

Deno.test("stable projection selects effects without changing their output", () => {
  const stable = PATCH_SCENARIOS[5]!;
  assertEquals(projectPatchScenarioValue(stable, 0), 0, "initial projection");
  for (let tick = 1; tick <= 8; tick++) {
    const value = updatePatchScenarioValue(stable, tick);
    assertEquals(projectPatchScenarioValue(stable, value), 0, `stable tick ${tick}`);
  }
});

Deno.test("high-fan-out scenarios expose eight unique dependencies per binding", () => {
  const plan = createPatchScenarioPlan(64, PATCH_SCENARIOS[3]!);
  assertEquals(plan.dependenciesPerBinding, 8, "dependency width");
  assertEquals([...plan.dependencyIds.subarray(0, 8)], [0, 7, 14, 21, 28, 35, 42, 49], "IDs");
  assertEquals(new Set(plan.dependencyIds.subarray(0, 8)).size, 8, "unique IDs");
});

Deno.test("patch scenario plans reject unsupported binding counts", () => {
  let failed = false;
  try {
    createPatchScenarioPlan(65, PATCH_SCENARIOS[0]!);
  } catch (error) {
    failed = error instanceof RangeError;
  }
  assertEquals(failed, true, "binding count validation");
});
