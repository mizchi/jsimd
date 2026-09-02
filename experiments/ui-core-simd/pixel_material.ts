export const MATERIAL = {
  empty: 0,
  wall: 1,
  sand: 2,
  water: 3,
  gas: 4,
  fire: 5,
  stone: 6,
  wood: 7,
  oil: 8,
  smoke: 9,
  acid: 10,
  lava: 11,
} as const;

export type PixelMaterial = (typeof MATERIAL)[keyof typeof MATERIAL];

export const ALL_PIXEL_MATERIALS = Object.freeze(
  Object.values(MATERIAL),
) as readonly PixelMaterial[];

// Dense byte tables are also the contract used by the Wasm i8x16.swizzle fast path.
const DENSITY = new Int8Array([0, 0, 4, 2, -1, 0, 0, 0, 1, -2, 2, 3]);
const FLUID = new Uint8Array([0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 1, 1]);
const MOVABLE = new Uint8Array([0, 0, 1, 1, 1, 0, 0, 0, 1, 1, 1, 1]);
const COMBUSTIBLE = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0]);
const HEAT_SOURCE = new Uint8Array([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1]);

export function materialDensity(material: number): number {
  return DENSITY[material] ?? 0;
}

export function materialIsFluid(material: number): boolean {
  return FLUID[material] === 1;
}

export function materialIsMovable(material: number): boolean {
  return MOVABLE[material] === 1;
}

export function materialIsSolid(material: number): boolean {
  return material !== MATERIAL.empty && !materialIsFluid(material);
}

export function materialIsCombustible(material: number): boolean {
  return COMBUSTIBLE[material] === 1;
}

export function materialIsHeatSource(material: number): boolean {
  return HEAT_SOURCE[material] === 1;
}
