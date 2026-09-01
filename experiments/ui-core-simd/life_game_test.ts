import { cellFromFixedPoint, countLiveCells, drawLifeLine, stepLife } from "./life_game.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

Deno.test("stepLife advances a blinker", () => {
  const width = 5;
  const height = 5;
  const current = new Uint8Array(width * height);
  const next = new Uint8Array(current.length);
  current[2 * width + 1] = 1;
  current[2 * width + 2] = 1;
  current[2 * width + 3] = 1;

  assertEquals(stepLife(current, next, width, height), 3);
  assertEquals(Array.from(next), [
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
  assertEquals(countLiveCells(next), 3);
});

Deno.test("drawLifeLine fills every cell on a fast diagonal drag", () => {
  const cells = new Uint8Array(8 * 6);
  drawLifeLine(cells, 8, 6, 1, 1, 6, 4, 1);

  assertEquals(countLiveCells(cells), 6);
  assertEquals(cells[1 * 8 + 1], 1);
  assertEquals(cells[4 * 8 + 6], 1);
});

Deno.test("cellFromFixedPoint maps client coordinates into a clipped grid", () => {
  const rect = {
    leftFixed: 10 * 64,
    topFixed: 20 * 64,
    widthFixed: 800 * 64,
    heightFixed: 400 * 64,
  };

  assertEquals(cellFromFixedPoint(410 * 64, 220 * 64, rect, 256, 160), { x: 128, y: 80 });
  assertEquals(cellFromFixedPoint(-1, -1, rect, 256, 160), { x: 0, y: 0 });
  assertEquals(cellFromFixedPoint(10_000 * 64, 10_000 * 64, rect, 256, 160), {
    x: 255,
    y: 159,
  });
});
