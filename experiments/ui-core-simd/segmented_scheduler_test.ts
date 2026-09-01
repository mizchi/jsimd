import { KeyedRegion, type RegionHost, type RegionSegment, ShowRegion } from "./regions.ts";
import { SegmentedEffectScheduler } from "./segmented_scheduler.ts";

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

Deno.test("segmented scheduler serves a synchronous overlay before packing it", async () => {
  const scheduler = new SegmentedEffectScheduler({
    signalCount: 4,
    rebuildChunkSize: 2,
    tombstoneRatio: 0.75,
    wasm: false,
  });
  const runs: string[] = [];
  scheduler.registerSegment([
    { signalIds: [0, 1], run: () => runs.push("a") },
  ]);
  scheduler.registerSegment([
    { signalIds: [1], run: () => runs.push("b") },
  ]);

  scheduler.batch(() => {
    scheduler.notify(0);
    scheduler.notify(1);
    scheduler.notify(1);
  });

  assertEquals(runs, ["a", "b"], "overlay effects run synchronously and deduplicate");
  await scheduler.settle();
  assertEquals(scheduler.stats.baseEffectCount, 2, "stable effects packed into base");
  assertEquals(scheduler.stats.overlayEffectCount, 0, "packed overlay cleared");
  assertEquals(scheduler.stats.rebuildCount, 1, "one base rebuild");
});

Deno.test("base tombstones and new overlay effects remain correct until compaction", async () => {
  const scheduler = new SegmentedEffectScheduler({
    signalCount: 3,
    rebuildChunkSize: 8,
    tombstoneRatio: 0.75,
    wasm: false,
  });
  const runs: string[] = [];
  const a = scheduler.registerSegment([{ signalIds: [1], run: () => runs.push("a") }]);
  const b = scheduler.registerSegment([{ signalIds: [1], run: () => runs.push("b") }]);
  await scheduler.compact();
  const c = scheduler.registerSegment([{ signalIds: [1], run: () => runs.push("c") }]);
  b.dispose();

  scheduler.notify(1);
  assertEquals(runs, ["a", "c"], "active base and overlay effects run in registration order");
  assertEquals(scheduler.stats.baseEffectCount, 2, "base retains stable slots");
  assertEquals(scheduler.stats.baseTombstoneCount, 1, "disposed base slot becomes tombstone");
  assertEquals(scheduler.stats.overlayEffectCount, 1, "new effect stays in scalar overlay");

  await scheduler.compact();
  assertEquals(scheduler.stats.baseEffectCount, 2, "compaction keeps only active effects");
  assertEquals(scheduler.stats.baseTombstoneCount, 0, "compaction removes tombstones");
  assertEquals(scheduler.stats.overlayEffectCount, 0, "compaction merges overlay");

  a.dispose();
  c.dispose();
});

Deno.test("automatic rebuild absorbs mutations that arrive while packing", async () => {
  const scheduler = new SegmentedEffectScheduler({
    signalCount: 1,
    rebuildChunkSize: 2,
    wasm: false,
  });
  scheduler.registerSegment([{ signalIds: [0], run: () => {} }]);
  scheduler.registerSegment([{ signalIds: [0], run: () => {} }]);
  scheduler.registerSegment([{ signalIds: [0], run: () => {} }]);

  await scheduler.settle();

  assertEquals(scheduler.stats.baseEffectCount, 3, "latest registration enters rebuilt base");
  assertEquals(scheduler.stats.overlayEffectCount, 0, "no raced registration is stranded");
  assertEquals(scheduler.stats.rebuildCount, 1, "only stable snapshot is installed");
});

Deno.test("tombstone threshold automatically compacts inactive base slots", async () => {
  const scheduler = new SegmentedEffectScheduler({
    signalCount: 1,
    rebuildChunkSize: 8,
    tombstoneRatio: 0.5,
    wasm: false,
  });
  const handles = Array.from(
    { length: 4 },
    () => scheduler.registerSegment([{ signalIds: [0], run: () => {} }]),
  );
  await scheduler.compact();
  handles[0]!.dispose();
  handles[1]!.dispose();

  await scheduler.settle();

  assertEquals(scheduler.stats.baseEffectCount, 2, "inactive half is removed");
  assertEquals(scheduler.stats.baseTombstoneCount, 0, "rebuilt base has no tombstones");
  assertEquals(scheduler.stats.rebuildCount, 2, "initial and threshold rebuilds complete");
});

Deno.test("scheduler drains nested notifications and completes a failing effect queue", () => {
  const scheduler = new SegmentedEffectScheduler({ signalCount: 2, wasm: false });
  const runs: string[] = [];
  scheduler.registerSegment([{
    signalIds: [0],
    run: () => {
      runs.push("first");
      scheduler.notify(1);
      throw new Error("expected");
    },
  }]);
  scheduler.registerSegment([{ signalIds: [0], run: () => runs.push("second") }]);
  scheduler.registerSegment([{ signalIds: [1], run: () => runs.push("nested") }]);

  assertThrows(() => scheduler.notify(0), Error);
  assertEquals(runs, ["first", "second", "nested"], "all queued rounds complete");
  assertEquals(scheduler.stats.lastEffectCount, 3, "all attempted effects counted");
  assertEquals(scheduler.stats.lastChangedSignalCount, 2, "nested signal round counted");
});

interface TestNode {
  readonly label: string;
}

class TestHost implements RegionHost<TestNode> {
  readonly nodes: TestNode[];

  constructor(marker: TestNode) {
    this.nodes = [marker];
  }

  placeBefore(nodes: readonly TestNode[], before: TestNode): void {
    for (const node of nodes) {
      const previous = this.nodes.indexOf(node);
      if (previous >= 0) this.nodes.splice(previous, 1);
      this.nodes.splice(this.nodes.indexOf(before), 0, node);
    }
  }

  remove(nodes: readonly TestNode[]): void {
    for (const node of nodes) {
      const index = this.nodes.indexOf(node);
      if (index >= 0) this.nodes.splice(index, 1);
    }
  }
}

Deno.test("Show and For region disposal deactivate their scheduler segments", () => {
  const scheduler = new SegmentedEffectScheduler({ signalCount: 1, wasm: false });
  const marker = { label: "end" };
  const host = new TestHost(marker);
  const show = new ShowRegion(host, marker);
  const list = new KeyedRegion<string, string, TestNode>(host, marker);
  const runs: string[] = [];

  show.update(true, () => {
    const binding = scheduler.registerSegment([{ signalIds: [0], run: () => runs.push("show") }]);
    return { nodes: [{ label: "show" }], dispose: () => binding.dispose() };
  });
  const mountItem = (item: string): RegionSegment<TestNode, string> => {
    const binding = scheduler.registerSegment([{
      signalIds: [0],
      run: () => runs.push(item),
    }]);
    return { nodes: [{ label: item }], dispose: () => binding.dispose() };
  };
  list.reconcile(["a", "b"], (item) => item, mountItem);
  scheduler.notify(0);

  show.update(false, () => {
    throw new Error("unused");
  });
  list.reconcile(["b"], (item) => item, mountItem);
  scheduler.notify(0);

  assertEquals(runs, ["show", "a", "b", "b"], "removed regions stop receiving updates");
});

Deno.test("segmented scheduler validates registration without partial mutation", () => {
  const scheduler = new SegmentedEffectScheduler({ signalCount: 2, wasm: false });
  assertThrows(
    () =>
      scheduler.registerSegment([
        { signalIds: [0], run: () => {} },
        { signalIds: [2], run: () => {} },
      ]),
    RangeError,
  );
  assertEquals(scheduler.stats.overlayEffectCount, 0, "invalid segment registers nothing");
});
