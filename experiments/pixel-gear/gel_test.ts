import {
  createPixelGelBlob,
  createPixelGelBlock,
  type PixelGelCluster,
  stepPixelGel,
} from "./gel.ts";
import type { PixelGearState } from "./gear.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function cellCount(clusters: readonly PixelGelCluster[]): number {
  return clusters.reduce((sum, cluster) => sum + cluster.cells.length / 2, 0);
}

function isFourConnected(cluster: PixelGelCluster): boolean {
  const remaining = new Set<string>();
  for (let index = 0; index < cluster.cells.length; index += 2) {
    remaining.add(
      `${Math.round(cluster.cells[index]! * 1_024)}:${
        Math.round(cluster.cells[index + 1]! * 1_024)
      }`,
    );
  }
  const first = remaining.values().next().value as string | undefined;
  if (first === undefined) return false;
  const pending = [first];
  remaining.delete(first);
  while (pending.length > 0) {
    const [x, y] = pending.pop()!.split(":").map(Number) as [number, number];
    for (const [offsetX, offsetY] of [[1_024, 0], [-1_024, 0], [0, 1_024], [0, -1_024]]) {
      const neighbor = `${x + offsetX}:${y + offsetY}`;
      if (remaining.delete(neighbor)) pending.push(neighbor);
    }
  }
  return remaining.size === 0;
}

const gear: PixelGearState = {
  centerX: 20,
  centerY: 20,
  radius: 8,
  toothDepth: 3,
  teeth: 10,
  angle: 0,
  angularVelocity: 0.3,
};

Deno.test("a gel block precomputes only its boundary for steady-state collision work", () => {
  const gel = createPixelGelBlock(20, 10, 8, 6, { strength: 10 });

  assertEquals(gel.cells.length / 2, 48);
  assertEquals(gel.boundary.length / 2, 24);

  const result = stepPixelGel([gel], 64, 48, null, { gravity: 0 });

  assertEquals(result.boundaryChecks, 24);
  assertEquals(result.fractures, 0);
});

Deno.test("a cohesive blob stores fewer boundary cells than bonded cells", () => {
  const gel = createPixelGelBlob(20, 10, 9, 6);

  assertEquals(gel.cells.length > gel.boundary.length, true);
  assertEquals(gel.cells.length / 2 > 100, true);
});

Deno.test("a weak bonded gel fractures locally under a rotating gear", () => {
  const gel = createPixelGelBlock(29, 20, 10, 8, { strength: 0.1 });
  const initialCells = cellCount([gel]);

  const result = stepPixelGel([gel], 64, 48, gear, { gravity: 0 });

  assertEquals(result.contacts > 0, true);
  assertEquals(result.fractures, 1);
  assertEquals(result.clusters.length, 2);
  assertEquals(cellCount(result.clusters), initialCells);
  assertEquals(
    result.clusters.reduce((sum, cluster) => sum + cluster.boundary.length / 2, 0) < initialCells,
    true,
  );
});

Deno.test("a strong bonded gel absorbs the same gear impulse without fracturing", () => {
  const gel = createPixelGelBlock(29, 20, 10, 8, { strength: 10_000 });

  const result = stepPixelGel([gel], 64, 48, gear, { gravity: 0 });

  assertEquals(result.contacts > 0, true);
  assertEquals(result.fractures, 0);
  assertEquals(result.clusters.length, 1);
  assertEquals(cellCount(result.clusters), 80);
});

Deno.test("repeated fractures retain compact boundary caches after Float32 recentering", () => {
  let clusters = [createPixelGelBlob(29, 20, 18, 12, { strength: 0.1 })];
  const initialCells = cellCount(clusters);
  for (let round = 0; round < 2; round++) {
    for (const cluster of clusters) {
      cluster.centerX = 29;
      cluster.centerY = 20;
      cluster.strength = 0.1;
      cluster.stress = 10;
      cluster.fractureCooldown = 0;
    }
    clusters = stepPixelGel(clusters, 64, 48, gear, {
      gravity: 0,
      minimumFragmentCells: 20,
    }).clusters;
  }

  const boundaryCells = clusters.reduce(
    (sum, cluster) => sum + cluster.boundary.length / 2,
    0,
  );
  assertEquals(cellCount(clusters), initialCells);
  assertEquals(boundaryCells < initialCells / 2, true);
  assertEquals(clusters.every(isFourConnected), true);
  assertEquals(clusters.every((cluster) => cluster.cells.length / 2 >= 4), true);
});

Deno.test("fracture follows a ragged lattice crack instead of a straight center cut", () => {
  const gel = createPixelGelBlock(29, 20, 24, 18, { strength: 0.1 });

  const result = stepPixelGel([gel], 64, 48, gear, { gravity: 0 });

  assertEquals(result.fractures, 1);
  const left = result.clusters.toSorted((a, b) => a.centerX - b.centerX)[0]!;
  const cutByRow = new Map<number, number>();
  for (let index = 0; index < left.cells.length; index += 2) {
    const worldX = left.centerX + left.cells[index]!;
    const worldY = Math.round(left.centerY + left.cells[index + 1]!);
    cutByRow.set(worldY, Math.max(cutByRow.get(worldY) ?? -Infinity, worldX));
  }
  const cutColumns = [...cutByRow.entries()].toSorted((a, b) => a[0] - b[0]).map((entry) =>
    entry[1]
  );
  const deltas = cutColumns.slice(1).map((value, index) => value - cutColumns[index]!);
  assertEquals(deltas.some((delta) => delta > 0.5), true);
  assertEquals(deltas.some((delta) => delta < -0.5), true);
});
