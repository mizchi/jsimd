import { PIXEL_EVENT_KIND, type PixelEventKind } from "./pixel_event_contract.ts";
import { MATERIAL, materialIsCombustible, materialIsHeatSource } from "./pixel_material.ts";

export const PIXEL_AMBIENT_TEMPERATURE = 128;
export const PIXEL_BOILING_TEMPERATURE = 140;
export const PIXEL_CONDENSING_TEMPERATURE = 112;
export const PIXEL_IGNITION_TEMPERATURE = 180;

const NEIGHBOR_WATER = 1;
const NEIGHBOR_HEAT_SOURCE = 2;
const NEIGHBOR_ACID = 4;
const NEIGHBOR_LAVA = 8;

export interface PixelReactionStepResult {
  readonly reactions: number;
}

export type PixelReactionCallback = (
  kind: PixelEventKind,
  index: number,
  before: number,
  after: number,
) => void;

/** Reference double-buffered four-neighbor temperature diffusion and phase changes. */
export function stepPixelReactions(
  cells: Uint32Array,
  scratch: Uint32Array,
  width: number,
  height: number,
  onReaction?: PixelReactionCallback,
): PixelReactionStepResult {
  validateWorld(cells, scratch, width, height);
  let reactions = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const before = cells[index]!;
      const material = before & 0xff;
      const neighborFlags = neighborMaterialFlags(cells, width, height, x, y);
      const temperature = materialIsHeatSource(material)
        ? 255
        : diffuseTemperature(cells, width, height, x, y);
      let nextMaterial = material;
      let kind: PixelEventKind | undefined;
      if (
        material === MATERIAL.water && (neighborFlags & NEIGHBOR_LAVA) !== 0 ||
        material === MATERIAL.lava && (neighborFlags & NEIGHBOR_WATER) !== 0
      ) {
        nextMaterial = MATERIAL.stone;
        kind = PIXEL_EVENT_KIND.solidified;
      } else if (
        material === MATERIAL.fire && (neighborFlags & NEIGHBOR_WATER) !== 0
      ) {
        nextMaterial = MATERIAL.smoke;
        kind = PIXEL_EVENT_KIND.extinguished;
      } else if (
        (material === MATERIAL.stone || material === MATERIAL.wood) &&
        (neighborFlags & NEIGHBOR_ACID) !== 0
      ) {
        nextMaterial = MATERIAL.empty;
        kind = PIXEL_EVENT_KIND.corroded;
      } else if (material === MATERIAL.water && temperature >= PIXEL_BOILING_TEMPERATURE) {
        nextMaterial = MATERIAL.gas;
        kind = PIXEL_EVENT_KIND.vaporized;
      } else if (material === MATERIAL.gas && temperature <= PIXEL_CONDENSING_TEMPERATURE) {
        nextMaterial = MATERIAL.water;
        kind = PIXEL_EVENT_KIND.condensed;
      } else if (
        materialIsCombustible(material) &&
        (temperature >= PIXEL_IGNITION_TEMPERATURE ||
          (neighborFlags & NEIGHBOR_HEAT_SOURCE) !== 0)
      ) {
        nextMaterial = MATERIAL.fire;
        kind = PIXEL_EVENT_KIND.ignited;
      }
      const after = ((before & 0xffff_0000) | temperature << 8 | nextMaterial) >>> 0;
      scratch[index] = after;
      if (kind !== undefined) {
        reactions++;
        onReaction?.(kind, index, before, after);
      }
    }
  }
  cells.set(scratch);
  return { reactions };
}

function neighborMaterialFlags(
  cells: Uint32Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  const index = y * width + x;
  const left = x === 0 ? index : index - 1;
  const right = x + 1 === width ? index : index + 1;
  const top = y === 0 ? index : index - width;
  const bottom = y + 1 === height ? index : index + width;
  return materialNeighborFlags(cells[left]! & 0xff) |
    materialNeighborFlags(cells[right]! & 0xff) |
    materialNeighborFlags(cells[top]! & 0xff) |
    materialNeighborFlags(cells[bottom]! & 0xff);
}

function materialNeighborFlags(material: number): number {
  if (material === MATERIAL.water) return NEIGHBOR_WATER;
  if (material === MATERIAL.fire) return NEIGHBOR_HEAT_SOURCE;
  if (material === MATERIAL.acid) return NEIGHBOR_ACID;
  if (material === MATERIAL.lava) return NEIGHBOR_HEAT_SOURCE | NEIGHBOR_LAVA;
  return 0;
}

function diffuseTemperature(
  cells: Uint32Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  const index = y * width + x;
  const left = x === 0 ? index : index - 1;
  const right = x + 1 === width ? index : index + 1;
  const top = y === 0 ? index : index - width;
  const bottom = y + 1 === height ? index : index + width;
  return (
    temperature(cells[index]!) * 4 + temperature(cells[left]!) +
    temperature(cells[right]!) + temperature(cells[top]!) + temperature(cells[bottom]!)
  ) >>> 3;
}

function temperature(cell: number): number {
  return cell >>> 8 & 0xff;
}

function validateWorld(
  cells: Uint32Array,
  scratch: Uint32Array,
  width: number,
  height: number,
): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new RangeError("reaction dimensions must be positive safe integers");
  }
  if (cells.length !== width * height || scratch.length !== cells.length) {
    throw new RangeError("reaction buffers must match the world dimensions");
  }
  if (cells.buffer === scratch.buffer) throw new TypeError("reaction buffers must be distinct");
}
