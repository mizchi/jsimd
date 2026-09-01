import {
  LIFE_OFFSCREEN_MIN_CELLS,
  parseLifeMainLoadMs,
  selectLifeRenderer,
} from "./life_options.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`expected ${expected}, got ${actual}`);
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

Deno.test("Life renderer auto-selection keeps small surfaces on the main thread", () => {
  assertEquals(selectLifeRenderer("auto", LIFE_OFFSCREEN_MIN_CELLS - 1, true), "main");
  assertEquals(selectLifeRenderer("auto", LIFE_OFFSCREEN_MIN_CELLS, true), "offscreen");
});

Deno.test("Life renderer auto-selection respects explicit choices", () => {
  assertEquals(selectLifeRenderer("main", 1_000_000, true), "main");
  assertEquals(selectLifeRenderer("offscreen", 1, true), "offscreen");
});

Deno.test("Life renderer falls back when OffscreenCanvas is unavailable", () => {
  assertEquals(selectLifeRenderer("auto", 1_000_000, false), "main");
  assertEquals(selectLifeRenderer("offscreen", 1_000_000, false), "main");
});

Deno.test("Life renderer rejects invalid cell counts", () => {
  assertThrows(() => selectLifeRenderer("auto", 0, true), RangeError);
  assertThrows(() => selectLifeRenderer("auto", Number.MAX_SAFE_INTEGER + 1, true), RangeError);
});

Deno.test("Life benchmark parses a bounded synthetic main-thread load", () => {
  assertEquals(parseLifeMainLoadMs(null), 0);
  assertEquals(parseLifeMainLoadMs("4"), 4);
  assertEquals(parseLifeMainLoadMs("8"), 8);
  assertThrows(() => parseLifeMainLoadMs("-1"), RangeError);
  assertThrows(() => parseLifeMainLoadMs("9"), RangeError);
  assertThrows(() => parseLifeMainLoadMs("nope"), RangeError);
});
