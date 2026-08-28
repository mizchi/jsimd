import {
  acquireVersionedRowGroupPin,
  pinnedVersionedRowGroupPageKeys,
} from "./versioned_row_group.ts";

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${message}: expected ${right}, got ${left}`);
}

Deno.test("versioned row-group pins retain exactly the observed immutable pages", () => {
  const backend = {};
  const first = acquireVersionedRowGroupPin(backend, "events", {
    generation: "first",
    rowGroups: [{ columns: { id: { key: "page/id-0" }, kind: { key: "page/kind-0" } } }],
  });
  const second = acquireVersionedRowGroupPin(backend, "events", {
    generation: "second",
    rowGroups: [{ columns: { id: { key: "page/id-0" }, kind: { key: "page/kind-1" } } }],
  });

  assertEquals(
    Array.from(pinnedVersionedRowGroupPageKeys(backend, "events")).sort(),
    ["page/id-0", "page/kind-0", "page/kind-1"],
    "both generations remain live",
  );
  first[Symbol.dispose]();
  assertEquals(
    Array.from(pinnedVersionedRowGroupPageKeys(backend, "events")).sort(),
    ["page/id-0", "page/kind-1"],
    "released generation no longer retains pages",
  );
  first[Symbol.dispose]();
  second[Symbol.dispose]();
  assertEquals(
    Array.from(pinnedVersionedRowGroupPageKeys(backend, "events")),
    [],
    "all pages become reclaimable",
  );
});

Deno.test("versioned row-group pins are isolated by backend and table", () => {
  const firstBackend = {};
  const secondBackend = {};
  using _first = acquireVersionedRowGroupPin(firstBackend, "events", {
    generation: "one",
    rowGroups: [{ columns: { id: { key: "events/id" } } }],
  });
  using _second = acquireVersionedRowGroupPin(secondBackend, "users", {
    generation: "one",
    rowGroups: [{ columns: { id: { key: "users/id" } } }],
  });

  assertEquals(
    Array.from(pinnedVersionedRowGroupPageKeys(firstBackend, "events")),
    ["events/id"],
    "first backend and table",
  );
  assertEquals(
    Array.from(pinnedVersionedRowGroupPageKeys(firstBackend, "users")),
    [],
    "table isolation",
  );
  assertEquals(
    Array.from(pinnedVersionedRowGroupPageKeys(secondBackend, "events")),
    [],
    "backend isolation",
  );
});
