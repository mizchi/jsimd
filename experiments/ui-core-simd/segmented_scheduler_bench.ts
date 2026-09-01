import { SegmentedEffectScheduler } from "./segmented_scheduler.ts";

let sink = 0;

for (
  const specification of [
    { name: "stable packed", replaced: 0 },
    { name: "64-effect overlay", replaced: 64 },
    { name: "128-effect overlay", replaced: 128 },
    { name: "512-effect overlay", replaced: 512 },
    { name: "half tombstone + overlay", replaced: 2_048 },
  ]
) {
  const effectCount = 4_096;
  const signalCount = 32;
  const scheduler = new SegmentedEffectScheduler({
    signalCount,
    rebuildChunkSize: effectCount + 1,
  });
  const handles = Array.from({ length: effectCount }, (_, effectId) =>
    scheduler.registerSegment([{
      signalIds: dependencyIds(effectId, signalCount),
      run: () => sink++,
    }]));
  await scheduler.compact();
  for (let index = 0; index < specification.replaced; index++) handles[index]!.dispose();
  for (let index = 0; index < specification.replaced; index++) {
    scheduler.registerSegment([{
      signalIds: dependencyIds(effectCount + index, signalCount),
      run: () => sink++,
    }]);
  }

  Deno.bench({
    name: specification.name,
    group: "segmented dispatch active=4096 changed=8",
    baseline: specification.replaced === 0,
    fn() {
      scheduler.batch(() => {
        for (let signalId = 0; signalId < 8; signalId++) scheduler.notify(signalId);
      });
    },
  });
}

function dependencyIds(effectId: number, signalCount: number): readonly number[] {
  return Array.from(
    { length: 4 },
    (_, offset) => (effectId * 5 + offset * 11) % signalCount,
  );
}
