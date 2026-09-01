export const PATCH_SCENARIO_SIGNAL_COUNT = 64;

export type PatchProjection = "identity" | "stable-even";

export interface PatchScenario {
  readonly id:
    | "sparse-batched"
    | "quarter-batched"
    | "dense-batched"
    | "dense-simd-batched"
    | "dense-unbatched"
    | "dense-stable";
  readonly label: string;
  readonly changedSignalCount: number;
  readonly batched: boolean;
  readonly projection: PatchProjection;
  readonly dependenciesPerBinding: 1 | 8;
}

export interface PatchScenarioPlan {
  readonly bindingCount: number;
  readonly signalCount: number;
  readonly sourceByBinding: Uint8Array;
  readonly dependencyIds: Uint8Array;
  readonly dependenciesPerBinding: 1 | 8;
  readonly changedSignalIds: Uint8Array;
  readonly affectedBindingCount: number;
  readonly expectedPatchCount: number;
  readonly flushCount: number;
}

export const PATCH_SCENARIOS: readonly PatchScenario[] = [
  {
    id: "sparse-batched",
    label: "1.6% affected / batched",
    changedSignalCount: 1,
    batched: true,
    projection: "identity",
    dependenciesPerBinding: 1,
  },
  {
    id: "quarter-batched",
    label: "25% affected / batched",
    changedSignalCount: 16,
    batched: true,
    projection: "identity",
    dependenciesPerBinding: 1,
  },
  {
    id: "dense-batched",
    label: "100% affected / batched",
    changedSignalCount: 64,
    batched: true,
    projection: "identity",
    dependenciesPerBinding: 1,
  },
  {
    id: "dense-simd-batched",
    label: "100% affected / SIMD fan-out",
    changedSignalCount: 64,
    batched: true,
    projection: "identity",
    dependenciesPerBinding: 8,
  },
  {
    id: "dense-unbatched",
    label: "100% affected / 64 flushes",
    changedSignalCount: 64,
    batched: false,
    projection: "identity",
    dependenciesPerBinding: 1,
  },
  {
    id: "dense-stable",
    label: "100% selected / stable output",
    changedSignalCount: 64,
    batched: true,
    projection: "stable-even",
    dependenciesPerBinding: 8,
  },
];

export function createPatchScenarioPlan(
  bindingCount: number,
  scenario: PatchScenario,
): PatchScenarioPlan {
  if (
    !Number.isSafeInteger(bindingCount) || bindingCount <= 0 ||
    bindingCount % PATCH_SCENARIO_SIGNAL_COUNT !== 0
  ) {
    throw new RangeError(
      `binding count must be a positive multiple of ${PATCH_SCENARIO_SIGNAL_COUNT}`,
    );
  }
  const sourceByBinding = new Uint8Array(bindingCount);
  const dependencyIds = new Uint8Array(bindingCount * scenario.dependenciesPerBinding);
  let affectedBindingCount = 0;
  for (let bindingId = 0; bindingId < bindingCount; bindingId++) {
    let affected = false;
    for (let offset = 0; offset < scenario.dependenciesPerBinding; offset++) {
      const signalId = scenario.dependenciesPerBinding === 1
        ? bindingId % PATCH_SCENARIO_SIGNAL_COUNT
        : (bindingId * 5 + offset * 7) % PATCH_SCENARIO_SIGNAL_COUNT;
      dependencyIds[bindingId * scenario.dependenciesPerBinding + offset] = signalId;
      if (offset === 0) sourceByBinding[bindingId] = signalId;
      if (signalId < scenario.changedSignalCount) affected = true;
    }
    if (affected) affectedBindingCount++;
  }
  const changedSignalIds = Uint8Array.from(
    { length: scenario.changedSignalCount },
    (_, signalId) => signalId,
  );
  return {
    bindingCount,
    signalCount: PATCH_SCENARIO_SIGNAL_COUNT,
    sourceByBinding,
    dependencyIds,
    dependenciesPerBinding: scenario.dependenciesPerBinding,
    changedSignalIds,
    affectedBindingCount,
    expectedPatchCount: scenario.projection === "stable-even" ? 0 : affectedBindingCount,
    flushCount: scenario.batched ? 1 : scenario.changedSignalCount,
  };
}

export function updatePatchScenarioValue(scenario: PatchScenario, tick: number): number {
  return scenario.projection === "stable-even" ? tick * 2 : tick;
}

export function projectPatchScenarioValue(scenario: PatchScenario, value: number): number {
  return scenario.projection === "stable-even" ? value & 1 : value;
}
