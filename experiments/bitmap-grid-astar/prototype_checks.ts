import { BitmapGridAStar } from "./prototype/mod.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("BitmapGridAStar routes around blocked cells", () => {
  const width = 7;
  const height = 5;
  const blocked = new Uint8Array(width * height);
  for (let y = 0; y < height - 1; y++) blocked[y * width + 3] = 1;
  using grid = BitmapGridAStar.fromObstacles(width, height, blocked);

  const result = grid.findPath(0, 0, 6, 0);
  const simd = grid.findPathSimd(0, 0, 6, 0);
  assert(result.distance === 14, "detour distance");
  assert(result.path[0] === 0 && result.path.at(-1) === 6, "path endpoints");
  assert(JSON.stringify(result) === JSON.stringify(simd), "SIMD and scalar path match");
  assertValidPath(result.path, width, blocked);
});

Deno.test("BitmapGridAStar reports unreachable and blocked endpoints", () => {
  const blocked = new Uint8Array([
    0,
    1,
    0,
    0,
    1,
    0,
    0,
    1,
    0,
  ]);
  using grid = BitmapGridAStar.fromObstacles(3, 3, blocked);
  const result = grid.findPath(0, 0, 2, 2);
  assert(result.distance === Infinity && result.path.length === 0, "unreachable path");

  let rejected = false;
  try {
    grid.findPath(1, 0, 2, 0);
  } catch (error) {
    rejected = error instanceof RangeError;
  }
  assert(rejected, "blocked start rejected");
});

Deno.test("BitmapGridAStar accepts packed obstacle words", () => {
  const words = new Uint32Array([1 << 5]);
  using grid = BitmapGridAStar.fromBitmap(8, 4, words);
  assert(grid.isBlocked(5, 0), "packed blocked cell");
  assert(!grid.isBlocked(4, 0), "packed open cell");
  assert(grid.findPath(0, 0, 7, 3).distance === 10, "packed grid path");
});

Deno.test("BitmapGridAStar returns allocator storage with using", () => {
  const before = BitmapGridAStar.allocatorStats();
  allocationPhase();
  const plateau = BitmapGridAStar.allocatorStats();
  allocationPhase();
  const after = BitmapGridAStar.allocatorStats();
  assert(after.liveAllocations === before.liveAllocations, "live allocations return");
  assert(after.liveBytes === before.liveBytes, "live bytes return");
  assert(after.reservedBytes === plateau.reservedBytes, "allocator plateaus");
});

function allocationPhase(): void {
  for (let iteration = 0; iteration < 8; iteration++) {
    using grid = BitmapGridAStar.fromObstacles(32, 32, new Uint8Array(32 * 32));
    grid.findPath(0, 0, 31, 31);
  }
}

function assertValidPath(path: Uint32Array, width: number, blocked: Uint8Array): void {
  for (let index = 0; index < path.length; index++) {
    assert(blocked[path[index]!] === 0, "path avoids walls");
    if (index === 0) continue;
    const delta = Math.abs(path[index]! - path[index - 1]!);
    assert(delta === 1 || delta === width, "path uses four-neighbor moves");
  }
}
