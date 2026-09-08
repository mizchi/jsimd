import type { PixelGearState } from "./gear.ts";

const PAGE_BYTES = 65_536;
const MEMORY_PAGES = 64;
const GEAR_PARAMS_PTR = PAGE_BYTES;
const BOUNDARY_PARAMS_PTR = GEAR_PARAMS_PTR + 64;
const BOUNDARY_RESULT_PTR = BOUNDARY_PARAMS_PTR + 64;
const WORLD_PTR = PAGE_BYTES * 2;

interface PixelGearWasmExports extends WebAssembly.Exports {
  readonly gear_contains: (gearParamsPtr: number, cellX: number, cellY: number) => number;
  readonly advance_gear: (
    cellsPtr: number,
    width: number,
    height: number,
    gearParamsPtr: number,
  ) => number;
  readonly step_pixel_world: (
    cellsPtr: number,
    width: number,
    height: number,
    phase: number,
  ) => number;
  readonly scan_gel_boundary: (
    localXPtr: number,
    localYPtr: number,
    count: number,
    paramsPtr: number,
    resultPtr: number,
  ) => number;
  readonly classify_gel_fracture: (
    localXPtr: number,
    localYPtr: number,
    sidesPtr: number,
    count: number,
    paramsPtr: number,
  ) => number;
}

export interface PixelGearKernelOptions {
  readonly wasmBytes?: BufferSource;
}

export interface PixelGelBoundaryTransform {
  readonly centerX: number;
  readonly centerY: number;
  readonly cosine: number;
  readonly sine: number;
}

export interface PixelGelBoundaryScan {
  readonly checks: number;
  readonly contacts: number;
  readonly minimumX: number;
  readonly maximumX: number;
  readonly maximumY: number;
  readonly correctionX: number;
  readonly correctionY: number;
  readonly contactNormalX: number;
  readonly contactNormalY: number;
  readonly contactLocalX: number;
  readonly contactLocalY: number;
  readonly stressDelta: number;
}

export interface PixelGelFracturePlane {
  readonly normalX: number;
  readonly normalY: number;
  readonly tangentX: number;
  readonly tangentY: number;
  readonly offset: number;
  readonly clusterId: number;
}

export interface PixelGelFractureClassification {
  readonly negativeCount: number;
  readonly sides: Uint8Array;
}

/**
 * Checked host boundary for the freestanding Zig leaf kernel. The Wasm side
 * owns no allocator; every pointer refers to this host-owned linear memory.
 */
export class PixelGearKernel {
  readonly memory: WebAssembly.Memory;
  readonly #exports: PixelGearWasmExports;
  #worldLength = 0;

  constructor(memory: WebAssembly.Memory, exports: PixelGearWasmExports) {
    this.memory = memory;
    this.#exports = exports;
  }

  createWorld(source: Uint32Array): Uint32Array {
    const end = WORLD_PTR + source.byteLength;
    this.#assertCapacity(end);
    this.#worldLength = source.length;
    const world = new Uint32Array(this.memory.buffer, WORLD_PTR, source.length);
    world.set(source);
    return world;
  }

  containsGearCell(gear: PixelGearState, x: number, y: number): boolean {
    this.#writeGear(GEAR_PARAMS_PTR, gear);
    return this.#exports.gear_contains(GEAR_PARAMS_PTR, x, y) !== 0;
  }

  advanceGear(
    cells: Uint32Array,
    width: number,
    height: number,
    gear: PixelGearState,
  ): number {
    this.#validateWorld(cells, width, height);
    this.#writeGear(GEAR_PARAMS_PTR, gear);
    return this.#exports.advance_gear(WORLD_PTR, width, height, GEAR_PARAMS_PTR);
  }

  stepWorld(cells: Uint32Array, width: number, height: number, phase: number): number {
    this.#validateWorld(cells, width, height);
    if (!Number.isSafeInteger(phase) || phase < 0) {
      throw new RangeError("pixel world phase must be a non-negative safe integer");
    }
    return this.#exports.step_pixel_world(WORLD_PTR, width, height, phase);
  }

  scanGelBoundary(
    localX: Float32Array,
    localY: Float32Array,
    transform: PixelGelBoundaryTransform,
    gear: PixelGearState | null,
  ): PixelGelBoundaryScan {
    if (localX.length !== localY.length || localX.length === 0) {
      throw new RangeError("gel boundary coordinates must have equal non-zero lengths");
    }
    const scratchStart = this.#scratchStart();
    const localXPtr = scratchStart;
    const localYPtr = align16(localXPtr + localX.byteLength);
    this.#assertCapacity(localYPtr + localY.byteLength);
    new Float32Array(this.memory.buffer, localXPtr, localX.length).set(localX);
    new Float32Array(this.memory.buffer, localYPtr, localY.length).set(localY);

    const params = new Float32Array(this.memory.buffer, BOUNDARY_PARAMS_PTR, 11);
    params.set([transform.centerX, transform.centerY, transform.cosine, transform.sine]);
    if (gear === null) params.fill(0, 4);
    else this.#writeGear(BOUNDARY_PARAMS_PTR + 4 * Float32Array.BYTES_PER_ELEMENT, gear);
    const contacts = this.#exports.scan_gel_boundary(
      localXPtr,
      localYPtr,
      localX.length,
      BOUNDARY_PARAMS_PTR,
      BOUNDARY_RESULT_PTR,
    );
    const output = new Float32Array(this.memory.buffer, BOUNDARY_RESULT_PTR, 10);
    return {
      checks: localX.length,
      contacts,
      minimumX: output[0]!,
      maximumX: output[1]!,
      maximumY: output[2]!,
      correctionX: output[3]!,
      correctionY: output[4]!,
      contactNormalX: output[5]!,
      contactNormalY: output[6]!,
      contactLocalX: output[7]!,
      contactLocalY: output[8]!,
      stressDelta: output[9]!,
    };
  }

  classifyGelFracture(
    cells: Float32Array,
    plane: PixelGelFracturePlane,
  ): PixelGelFractureClassification {
    if (cells.length === 0 || cells.length % 2 !== 0) {
      throw new RangeError("gel fracture cells must contain non-empty x/y pairs");
    }
    if (
      !Number.isSafeInteger(plane.clusterId) || plane.clusterId < 0 ||
      ![
        plane.normalX,
        plane.normalY,
        plane.tangentX,
        plane.tangentY,
        plane.offset,
      ].every(Number.isFinite)
    ) throw new RangeError("gel fracture plane is invalid");

    const count = cells.length / 2;
    const localXPtr = this.#scratchStart();
    const localYPtr = align16(localXPtr + count * Float32Array.BYTES_PER_ELEMENT);
    const sidesPtr = align16(localYPtr + count * Float32Array.BYTES_PER_ELEMENT);
    this.#assertCapacity(sidesPtr + count);
    const localX = new Float32Array(this.memory.buffer, localXPtr, count);
    const localY = new Float32Array(this.memory.buffer, localYPtr, count);
    for (let index = 0; index < count; index++) {
      localX[index] = cells[index * 2]!;
      localY[index] = cells[index * 2 + 1]!;
    }
    new Float32Array(this.memory.buffer, BOUNDARY_PARAMS_PTR, 6).set([
      plane.normalX,
      plane.normalY,
      plane.tangentX,
      plane.tangentY,
      plane.offset,
      plane.clusterId,
    ]);
    const negativeCount = this.#exports.classify_gel_fracture(
      localXPtr,
      localYPtr,
      sidesPtr,
      count,
      BOUNDARY_PARAMS_PTR,
    );
    const sides = new Uint8Array(this.memory.buffer, sidesPtr, count).slice();
    return { negativeCount, sides };
  }

  #writeGear(pointer: number, gear: PixelGearState): void {
    new Float32Array(this.memory.buffer, pointer, 7).set([
      gear.centerX,
      gear.centerY,
      gear.radius,
      gear.toothDepth,
      gear.teeth,
      gear.angle,
      gear.angularVelocity,
    ]);
  }

  #validateWorld(cells: Uint32Array, width: number, height: number): void {
    if (
      !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 ||
      cells.buffer !== this.memory.buffer || cells.byteOffset !== WORLD_PTR ||
      cells.length !== this.#worldLength || cells.length !== width * height
    ) throw new RangeError("pixel world must be created by this Zig kernel");
  }

  #assertCapacity(end: number): void {
    if (!Number.isSafeInteger(end) || end > this.memory.buffer.byteLength) {
      throw new RangeError("pixel gear kernel host memory capacity exceeded");
    }
  }

  #scratchStart(): number {
    return align16(WORLD_PTR + this.#worldLength * Uint32Array.BYTES_PER_ELEMENT);
  }
}

export async function createPixelGearKernel(
  options: PixelGearKernelOptions = {},
): Promise<PixelGearKernel> {
  const memory = new WebAssembly.Memory({ initial: MEMORY_PAGES, maximum: MEMORY_PAGES });
  let bytes: BufferSource;
  if (options.wasmBytes !== undefined) bytes = options.wasmBytes;
  else {
    const response = await fetch(new URL("./zig/kernel.wasm", import.meta.url));
    if (!response.ok) throw new Error(`failed to load Zig kernel: ${response.status}`);
    bytes = await response.arrayBuffer();
  }
  const { instance } = await WebAssembly.instantiate(bytes, { env: { memory } });
  const exports = instance.exports as PixelGearWasmExports;
  for (
    const name of [
      "gear_contains",
      "advance_gear",
      "step_pixel_world",
      "scan_gel_boundary",
      "classify_gel_fracture",
    ] as const
  ) {
    if (typeof exports[name] !== "function") throw new TypeError(`Zig kernel is missing ${name}`);
  }
  return new PixelGearKernel(memory, exports);
}

function align16(value: number): number {
  return (value + 15) & ~15;
}
