import { KeyedRegion, type RegionHost, type RegionSegment, ShowRegion } from "./regions.ts";

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
      const oldIndex = this.nodes.indexOf(node);
      if (oldIndex >= 0) this.nodes.splice(oldIndex, 1);
      const nextIndex = this.nodes.indexOf(before);
      if (nextIndex < 0) throw new Error("cursor not found");
      this.nodes.splice(nextIndex, 0, node);
    }
  }

  remove(nodes: readonly TestNode[]): void {
    for (const node of nodes) {
      const index = this.nodes.indexOf(node);
      if (index >= 0) this.nodes.splice(index, 1);
    }
  }
}

function labels(host: TestHost): string[] {
  return host.nodes.map((node) => node.label);
}

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

Deno.test("ShowRegion mounts one segment and disposes it before removal", () => {
  const marker = { label: "end" };
  const host = new TestHost(marker);
  const events: string[] = [];
  const region = new ShowRegion(host, marker);
  const mount = (): RegionSegment<TestNode> => ({
    nodes: [{ label: "a" }, { label: "b" }],
    dispose: () => events.push(`dispose:${labels(host).join(",")}`),
  });

  region.update(false, mount);
  region.update(true, mount);
  region.update(true, () => {
    throw new Error("must reuse mounted segment");
  });
  assertEquals(labels(host), ["a", "b", "end"], "shown nodes");

  region.update(false, mount);
  assertEquals(events, ["dispose:a,b,end"], "dispose sees attached nodes");
  assertEquals(labels(host), ["end"], "hidden nodes");
});

Deno.test("KeyedRegion reuses, moves, updates, and disposes segments by key", () => {
  const marker = { label: "end" };
  const host = new TestHost(marker);
  const mounted: string[] = [];
  const updated: string[] = [];
  const disposed: string[] = [];
  const region = new KeyedRegion<string, { id: string; value: number }, TestNode>(host, marker);
  const mount = (
    item: { id: string; value: number },
    index: number,
  ): RegionSegment<TestNode, { id: string; value: number }> => {
    mounted.push(`${item.id}:${index}`);
    return {
      nodes: [{ label: item.id }, { label: `${item.id}-tail` }],
      update: (next, nextIndex) => updated.push(`${next.id}:${next.value}:${nextIndex}`),
      dispose: () => disposed.push(item.id),
    };
  };
  const key = (item: { id: string }) => item.id;

  region.reconcile([{ id: "a", value: 1 }, { id: "b", value: 2 }], key, mount);
  region.reconcile([{ id: "b", value: 3 }, { id: "c", value: 4 }], key, mount);

  assertEquals(
    labels(host),
    ["b", "b-tail", "c", "c-tail", "end"],
    "keyed order",
  );
  assertEquals(mounted, ["a:0", "b:1", "c:1"], "only new keys mount");
  assertEquals(updated, ["b:3:0"], "reused key receives new item and index");
  assertEquals(disposed, ["a"], "removed key is disposed");

  region.destroy();
  assertEquals(disposed, ["a", "b", "c"], "destroy disposes remaining segments");
  assertEquals(labels(host), ["end"], "destroy removes remaining nodes");
});

Deno.test("KeyedRegion validates keys and non-empty segment node ranges before mutation", () => {
  const marker = { label: "end" };
  const host = new TestHost(marker);
  const region = new KeyedRegion<string, { id: string }, TestNode>(host, marker);

  assertThrows(
    () =>
      region.reconcile(
        [{ id: "x" }, { id: "x" }],
        (item) => item.id,
        (item) => ({ nodes: [{ label: item.id }], dispose: () => {} }),
      ),
    TypeError,
  );
  assertEquals(labels(host), ["end"], "duplicate keys do not mutate the region");

  assertThrows(
    () =>
      region.reconcile(
        [{ id: "x" }],
        (item) => item.id,
        () => ({ nodes: [], dispose: () => {} }),
      ),
    TypeError,
  );
  assertEquals(labels(host), ["end"], "empty segment does not mutate the region");
});

Deno.test("regions dispose resources created by an invalid mount", () => {
  const marker = { label: "end" };
  const host = new TestHost(marker);
  const disposed: string[] = [];
  const show = new ShowRegion(host, marker);
  const keyed = new KeyedRegion<string, { id: string }, TestNode>(host, marker);

  assertThrows(
    () =>
      show.update(true, () => ({
        nodes: [],
        dispose: () => disposed.push("show"),
      })),
    TypeError,
  );
  assertThrows(
    () =>
      keyed.reconcile(
        [{ id: "x" }],
        (item) => item.id,
        () => ({ nodes: [], dispose: () => disposed.push("keyed") }),
      ),
    TypeError,
  );

  assertEquals(disposed, ["show", "keyed"], "invalid mounts are disposed");
  assertEquals(labels(host), ["end"], "invalid mounts remain detached");
});
