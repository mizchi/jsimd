import { isPixelGearCell, type PixelGearState } from "./gear.ts";

export interface PixelGelCluster {
  readonly id: number;
  /** Local cell centers stored as x/y pairs. Rebuilt only when the cluster fractures. */
  readonly cells: Float32Array;
  /** Local boundary cell centers used by the steady-state collision loop. */
  readonly boundary: Float32Array;
  centerX: number;
  centerY: number;
  angle: number;
  velocityX: number;
  velocityY: number;
  angularVelocity: number;
  stress: number;
  strength: number;
  fractureCooldown: number;
}

export interface PixelGelStepOptions {
  readonly gravity?: number;
  readonly damping?: number;
  readonly stressDecay?: number;
  readonly minimumFragmentCells?: number;
}

export interface PixelGelStepResult {
  readonly clusters: PixelGelCluster[];
  readonly boundaryChecks: number;
  readonly contacts: number;
  readonly fractures: number;
}

let nextClusterId = 1;

export function createPixelGelBlock(
  centerX: number,
  centerY: number,
  width: number,
  height: number,
  options: { readonly strength?: number } = {},
): PixelGelCluster {
  if (
    !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 ||
    !Number.isFinite(centerX) || !Number.isFinite(centerY)
  ) throw new RangeError("pixel gel block parameters are invalid");
  const cells = new Float32Array(width * height * 2);
  let cursor = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      cells[cursor++] = x - (width - 1) / 2;
      cells[cursor++] = y - (height - 1) / 2;
    }
  }
  return createCluster(cells, centerX, centerY, options.strength ?? 18);
}

export function createPixelGelBlob(
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number,
  options: { readonly strength?: number } = {},
): PixelGelCluster {
  if (
    !Number.isFinite(centerX) || !Number.isFinite(centerY) ||
    !Number.isFinite(radiusX) || !Number.isFinite(radiusY) || radiusX < 1 || radiusY < 1
  ) throw new RangeError("pixel gel blob parameters are invalid");
  const points: number[] = [];
  for (let y = -Math.ceil(radiusY); y <= Math.ceil(radiusY); y++) {
    for (let x = -Math.ceil(radiusX); x <= Math.ceil(radiusX); x++) {
      if ((x / radiusX) ** 2 + (y / radiusY) ** 2 <= 1) points.push(x, y);
    }
  }
  return createCluster(new Float32Array(points), centerX, centerY, options.strength ?? 18);
}

/**
 * Advances bonded gel aggregates. Normal motion only checks cached boundary
 * cells; the complete cell set is visited only by the fracture path.
 */
export function stepPixelGel(
  clusters: readonly PixelGelCluster[],
  width: number,
  height: number,
  gear: PixelGearState | null,
  options: PixelGelStepOptions = {},
): PixelGelStepResult {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError("pixel gel world dimensions must be positive safe integers");
  }
  const gravity = finiteOption(options.gravity, 0.075, "gravity");
  const damping = finiteOption(options.damping, 0.992, "damping");
  const stressDecay = finiteOption(options.stressDecay, 0.965, "stress decay");
  const minimumFragmentCells = options.minimumFragmentCells ?? 18;
  if (!Number.isSafeInteger(minimumFragmentCells) || minimumFragmentCells < 1) {
    throw new RangeError("minimum gel fragment size must be a positive safe integer");
  }

  const next: PixelGelCluster[] = [];
  let boundaryChecks = 0;
  let contacts = 0;
  let fractures = 0;
  for (const cluster of clusters) {
    cluster.velocityY += gravity;
    cluster.centerX += cluster.velocityX;
    cluster.centerY += cluster.velocityY;
    cluster.angle += cluster.angularVelocity;
    cluster.velocityX *= damping;
    cluster.velocityY *= damping;
    cluster.angularVelocity *= damping;
    cluster.stress *= stressDecay;
    if (cluster.fractureCooldown > 0) cluster.fractureCooldown--;

    const cosine = Math.cos(cluster.angle);
    const sine = Math.sin(cluster.angle);
    let correctionX = 0;
    let correctionY = 0;
    let contactNormalX = 0;
    let contactNormalY = -1;
    let contactLocalX = 0;
    let contactLocalY = 0;
    let clusterContacts = 0;
    let maximumX = -Infinity;
    let minimumX = Infinity;
    let maximumY = -Infinity;
    boundaryChecks += cluster.boundary.length / 2;
    for (let index = 0; index < cluster.boundary.length; index += 2) {
      const localX = cluster.boundary[index]!;
      const localY = cluster.boundary[index + 1]!;
      const worldX = cluster.centerX + localX * cosine - localY * sine;
      const worldY = cluster.centerY + localX * sine + localY * cosine;
      minimumX = Math.min(minimumX, worldX);
      maximumX = Math.max(maximumX, worldX);
      maximumY = Math.max(maximumY, worldY);
      if (gear === null || !isPixelGearCell(gear, Math.floor(worldX), Math.floor(worldY))) continue;

      const deltaX = worldX - gear.centerX;
      const deltaY = worldY - gear.centerY;
      const distance = Math.max(0.001, Math.hypot(deltaX, deltaY));
      const normalX = deltaX / distance;
      const normalY = deltaY / distance;
      const rotation = Math.sign(gear.angularVelocity) || 1;
      const tangentX = -normalY * rotation;
      const tangentY = normalX * rotation;
      const surfaceSpeed = Math.abs(gear.angularVelocity) * distance;
      const impulse = 0.12 + surfaceSpeed * 0.18;
      correctionX += normalX * 0.85 + tangentX * surfaceSpeed * 0.08;
      correctionY += normalY * 0.85 + tangentY * surfaceSpeed * 0.08;
      contactNormalX += normalX;
      contactNormalY += normalY;
      contactLocalX += localX;
      contactLocalY += localY;
      cluster.stress += impulse;
      clusterContacts++;
      contacts++;
    }

    if (clusterContacts > 0 && gear !== null) {
      const inverseContacts = 1 / clusterContacts;
      cluster.centerX += correctionX * inverseContacts;
      cluster.centerY += correctionY * inverseContacts;
      const normalLength = Math.max(0.001, Math.hypot(contactNormalX, contactNormalY));
      contactNormalX /= normalLength;
      contactNormalY /= normalLength;
      contactLocalX *= inverseContacts;
      contactLocalY *= inverseContacts;
      const rotation = Math.sign(gear.angularVelocity) || 1;
      const tangentX = -contactNormalY * rotation;
      const tangentY = contactNormalX * rotation;
      const drive = Math.abs(gear.angularVelocity) * (gear.radius + gear.toothDepth);
      cluster.velocityX += tangentX * drive * 0.025 + contactNormalX * 0.035;
      cluster.velocityY += tangentY * drive * 0.025 + contactNormalY * 0.035;
      cluster.angularVelocity += gear.angularVelocity * 0.018;
    }

    if (minimumX < 1) {
      cluster.centerX += 1 - minimumX;
      cluster.velocityX = Math.abs(cluster.velocityX) * 0.12;
    } else if (maximumX > width - 2) {
      cluster.centerX -= maximumX - (width - 2);
      cluster.velocityX = -Math.abs(cluster.velocityX) * 0.12;
    }
    if (maximumY > height - 2) {
      cluster.centerY -= maximumY - (height - 2);
      cluster.velocityY = -Math.abs(cluster.velocityY) * 0.08;
      cluster.velocityX *= 0.82;
      cluster.angularVelocity *= 0.82;
    }

    if (
      clusterContacts > 0 && cluster.stress > cluster.strength &&
      cluster.fractureCooldown === 0 &&
      cluster.cells.length / 2 >= minimumFragmentCells * 2
    ) {
      const fragments = fractureCluster(
        cluster,
        contactNormalX,
        contactNormalY,
        contactLocalX,
        contactLocalY,
        minimumFragmentCells,
      );
      if (fragments !== null) {
        next.push(...fragments);
        fractures++;
        continue;
      }
    }
    next.push(cluster);
  }
  return { clusters: next, boundaryChecks, contacts, fractures };
}

function fractureCluster(
  cluster: PixelGelCluster,
  worldNormalX: number,
  worldNormalY: number,
  contactLocalX: number,
  contactLocalY: number,
  minimumFragmentCells: number,
): PixelGelCluster[] | null {
  const cosine = Math.cos(cluster.angle);
  const sine = Math.sin(cluster.angle);
  const localNormalX = worldNormalX * cosine + worldNormalY * sine;
  const localNormalY = -worldNormalX * sine + worldNormalY * cosine;
  const tangentX = -localNormalY;
  const tangentY = localNormalX;
  const contactProjection = contactLocalX * localNormalX + contactLocalY * localNormalY;
  const maximumOffset = Math.sqrt(cluster.cells.length / 2) * 0.22;
  const crackOffset = clamp(contactProjection * 0.28, -maximumOffset, maximumOffset);
  const negative: number[] = [];
  const positive: number[] = [];
  for (let index = 0; index < cluster.cells.length; index += 2) {
    const x = cluster.cells[index]!;
    const y = cluster.cells[index + 1]!;
    const tangentPosition = x * tangentX + y * tangentY;
    const signedDistance = x * localNormalX + y * localNormalY - crackOffset +
      crackNoise(tangentPosition, cluster.id);
    const target = signedDistance < 0 ? negative : positive;
    target.push(x, y);
  }
  if (
    negative.length / 2 < minimumFragmentCells || positive.length / 2 < minimumFragmentCells
  ) return null;
  const [negativeComponents, positiveComponents] = normalizeCrackComponents(negative, positive);
  const fragments: PixelGelCluster[] = [];
  for (const component of negativeComponents) {
    fragments.push(createFragment(cluster, component, -1, localNormalX, localNormalY));
  }
  for (const component of positiveComponents) {
    fragments.push(createFragment(cluster, component, 1, localNormalX, localNormalY));
  }
  return fragments.length < 2 ? null : fragments;
}

function normalizeCrackComponents(
  negative: readonly number[],
  positive: readonly number[],
): readonly [Float32Array[], Float32Array[]] {
  const negativeComponents = collectConnectedComponents(negative);
  const positiveComponents = collectConnectedComponents(positive);
  const minimumChipCells = 4;
  const negativeIslands = negativeComponents.filter((part) => part.length / 2 < minimumChipCells);
  const positiveIslands = positiveComponents.filter((part) => part.length / 2 < minimumChipCells);
  return [
    collectConnectedComponents(flattenComponents(
      negativeComponents.filter((part) => part.length / 2 >= minimumChipCells),
      positiveIslands,
    )),
    collectConnectedComponents(flattenComponents(
      positiveComponents.filter((part) => part.length / 2 >= minimumChipCells),
      negativeIslands,
    )),
  ];
}

function flattenComponents(
  main: readonly Float32Array[],
  additions: readonly Float32Array[],
): number[] {
  const points: number[] = [];
  for (const component of [...main, ...additions]) {
    for (const value of component) points.push(value);
  }
  return points;
}

function collectConnectedComponents(points: readonly number[]): Float32Array[] {
  const remaining = new Map<string, readonly [number, number]>();
  for (let index = 0; index < points.length; index += 2) {
    const point = [points[index]!, points[index + 1]!] as const;
    remaining.set(cellKey(point[0], point[1]), point);
  }
  const components: Float32Array[] = [];
  while (remaining.size > 0) {
    const first = remaining.values().next().value as readonly [number, number];
    const pending = [first];
    const component: number[] = [];
    remaining.delete(cellKey(first[0], first[1]));
    while (pending.length > 0) {
      const point = pending.pop()!;
      component.push(point[0], point[1]);
      for (
        const [x, y] of [
          [point[0] - 1, point[1]],
          [point[0] + 1, point[1]],
          [point[0], point[1] - 1],
          [point[0], point[1] + 1],
        ] as const
      ) {
        const neighbor = remaining.get(cellKey(x, y));
        if (neighbor === undefined) continue;
        remaining.delete(cellKey(x, y));
        pending.push(neighbor);
      }
    }
    components.push(new Float32Array(component));
  }
  return components;
}

function createFragment(
  parent: PixelGelCluster,
  parentLocalCells: Float32Array,
  side: number,
  localNormalX: number,
  localNormalY: number,
): PixelGelCluster {
  let centerLocalX = 0;
  let centerLocalY = 0;
  for (let index = 0; index < parentLocalCells.length; index += 2) {
    centerLocalX += parentLocalCells[index]!;
    centerLocalY += parentLocalCells[index + 1]!;
  }
  const count = parentLocalCells.length / 2;
  centerLocalX /= count;
  centerLocalY /= count;
  const cells = new Float32Array(parentLocalCells.length);
  for (let index = 0; index < parentLocalCells.length; index += 2) {
    cells[index] = parentLocalCells[index]! - centerLocalX;
    cells[index + 1] = parentLocalCells[index + 1]! - centerLocalY;
  }
  const cosine = Math.cos(parent.angle);
  const sine = Math.sin(parent.angle);
  const offsetX = centerLocalX * cosine - centerLocalY * sine;
  const offsetY = centerLocalX * sine + centerLocalY * cosine;
  const fragment = createCluster(
    cells,
    parent.centerX + offsetX,
    parent.centerY + offsetY,
    parent.strength * 2.2,
  );
  fragment.angle = parent.angle;
  fragment.velocityX = parent.velocityX - parent.angularVelocity * offsetY;
  fragment.velocityY = parent.velocityY + parent.angularVelocity * offsetX;
  fragment.angularVelocity = parent.angularVelocity + side * 0.012;
  fragment.fractureCooldown = 24;
  const worldNormalForFragmentX = localNormalX * cosine - localNormalY * sine;
  const worldNormalForFragmentY = localNormalX * sine + localNormalY * cosine;
  fragment.centerX += worldNormalForFragmentX * side * 1.35;
  fragment.centerY += worldNormalForFragmentY * side * 1.35;
  return fragment;
}

function createCluster(
  cells: Float32Array,
  centerX: number,
  centerY: number,
  strength: number,
): PixelGelCluster {
  if (!Number.isFinite(strength) || strength <= 0) {
    throw new RangeError("pixel gel strength must be positive");
  }
  return {
    id: nextClusterId++,
    cells,
    boundary: collectBoundary(cells),
    centerX,
    centerY,
    angle: 0,
    velocityX: 0,
    velocityY: 0,
    angularVelocity: 0,
    stress: 0,
    strength,
    fractureCooldown: 0,
  };
}

function collectBoundary(cells: Float32Array): Float32Array {
  const occupied = new Set<string>();
  for (let index = 0; index < cells.length; index += 2) {
    occupied.add(cellKey(cells[index]!, cells[index + 1]!));
  }
  const boundary: number[] = [];
  for (let index = 0; index < cells.length; index += 2) {
    const x = cells[index]!;
    const y = cells[index + 1]!;
    if (
      !occupied.has(cellKey(x - 1, y)) || !occupied.has(cellKey(x + 1, y)) ||
      !occupied.has(cellKey(x, y - 1)) || !occupied.has(cellKey(x, y + 1))
    ) boundary.push(x, y);
  }
  return new Float32Array(boundary);
}

function cellKey(x: number, y: number): string {
  // Fragments are recentered in Float32 storage. Quantization removes the
  // sub-ULP drift while preserving the unit-spaced bonded lattice.
  return `${Math.round(x * 1_024)}:${Math.round(y * 1_024)}`;
}

function crackNoise(tangentPosition: number, clusterId: number): number {
  const seed = clusterId * 0.731;
  // Keep the derivative below roughly one cell per cell so both sides of the
  // crack remain 4-connected instead of leaving detached one-cell islands.
  return Math.sin(tangentPosition * 0.32 + seed) * 1.55 +
    Math.sin(tangentPosition * 0.13 - seed * 0.7) * 0.8;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function finiteOption(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved)) throw new RangeError(`pixel gel ${name} must be finite`);
  return resolved;
}
