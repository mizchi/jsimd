import type { FixedRect } from "./life_game.ts";

const MAGIC = 0x5058_574b;
const VERSION = 1;
const HEADER_WORDS = 20;
const HEADER_BYTES = HEADER_WORDS * Int32Array.BYTES_PER_ELEMENT;

const HEADER = {
  magic: 0,
  version: 1,
  width: 2,
  height: 3,
  sequence: 4,
  tick: 5,
  computeMicros: 6,
  renderMicros: 7,
  activeChunks: 8,
  running: 9,
  viewportLeft: 10,
  viewportTop: 11,
  viewportWidth: 12,
  viewportHeight: 13,
  brushMaterial: 14,
  inputTimeMicros: 15,
  inputSequence: 16,
  rate: 17,
  reserved0: 18,
  reserved1: 19,
} as const;

export const PIXEL_WORKER_STATS_WORDS = 8;

/** Small shared control plane; the pixel world remains worker-owned. */
export class PixelWorkerControl {
  readonly buffer: SharedArrayBuffer;
  readonly width: number;
  readonly height: number;
  readonly #header: Int32Array;

  private constructor(buffer: SharedArrayBuffer) {
    if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength !== HEADER_BYTES) {
      throw new TypeError("invalid pixel worker-control size");
    }
    this.buffer = buffer;
    this.#header = new Int32Array(buffer);
    if (
      this.#header[HEADER.magic] !== MAGIC ||
      this.#header[HEADER.version] !== VERSION
    ) {
      throw new TypeError("invalid pixel worker-control ABI");
    }
    this.width = this.#header[HEADER.width];
    this.height = this.#header[HEADER.height];
    if (
      this.width <= 0 ||
      this.height <= 0 ||
      !Number.isSafeInteger(this.width * this.height)
    ) {
      throw new TypeError("invalid pixel worker-control dimensions");
    }
  }

  static create(width: number, height: number): PixelWorkerControl {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new RangeError("pixel dimensions must be positive integers");
    }
    const cellCount = width * height;
    if (!Number.isSafeInteger(cellCount) || cellCount > 16_777_216) {
      throw new RangeError("pixel world is too large");
    }
    const buffer = new SharedArrayBuffer(HEADER_BYTES);
    const header = new Int32Array(buffer);
    header[HEADER.magic] = MAGIC;
    header[HEADER.version] = VERSION;
    header[HEADER.width] = width;
    header[HEADER.height] = height;
    header[HEADER.running] = 1;
    header[HEADER.brushMaterial] = 2;
    header[HEADER.rate] = 60;
    return new PixelWorkerControl(buffer);
  }

  static attach(buffer: SharedArrayBuffer): PixelWorkerControl {
    return new PixelWorkerControl(buffer);
  }

  get running(): boolean {
    return Atomics.load(this.#header, HEADER.running) !== 0;
  }

  set running(value: boolean) {
    Atomics.store(this.#header, HEADER.running, value ? 1 : 0);
  }

  get rate(): number {
    return Atomics.load(this.#header, HEADER.rate);
  }

  setRate(rate: number): void {
    if (!Number.isFinite(rate)) throw new TypeError("pixel rate must be finite");
    Atomics.store(this.#header, HEADER.rate, Math.max(1, Math.min(120, Math.round(rate))));
  }

  get brushMaterial(): number {
    return Atomics.load(this.#header, HEADER.brushMaterial);
  }

  set brushMaterial(material: number) {
    if (!Number.isInteger(material) || material < 0 || material > 3) {
      throw new RangeError("pixel brush material must be between 0 and 3");
    }
    Atomics.store(this.#header, HEADER.brushMaterial, material);
  }

  get viewport(): FixedRect {
    return {
      leftFixed: Atomics.load(this.#header, HEADER.viewportLeft),
      topFixed: Atomics.load(this.#header, HEADER.viewportTop),
      widthFixed: Atomics.load(this.#header, HEADER.viewportWidth),
      heightFixed: Atomics.load(this.#header, HEADER.viewportHeight),
    };
  }

  setViewportFixed(
    leftFixed: number,
    topFixed: number,
    widthFixed: number,
    heightFixed: number,
  ): void {
    Atomics.store(this.#header, HEADER.viewportLeft, leftFixed | 0);
    Atomics.store(this.#header, HEADER.viewportTop, topFixed | 0);
    Atomics.store(this.#header, HEADER.viewportWidth, Math.max(1, widthFixed | 0));
    Atomics.store(this.#header, HEADER.viewportHeight, Math.max(1, heightFixed | 0));
  }

  publish(
    tick: number,
    computeMicros: number,
    renderMicros: number,
    activeChunks: number,
    inputTimeMicros?: number,
  ): void {
    Atomics.add(this.#header, HEADER.sequence, 1);
    Atomics.store(this.#header, HEADER.tick, tick | 0);
    Atomics.store(this.#header, HEADER.computeMicros, clampMicros(computeMicros));
    Atomics.store(this.#header, HEADER.renderMicros, clampMicros(renderMicros));
    Atomics.store(this.#header, HEADER.activeChunks, Math.max(0, activeChunks | 0));
    if (inputTimeMicros !== undefined) {
      Atomics.store(this.#header, HEADER.inputTimeMicros, inputTimeMicros | 0);
      Atomics.add(this.#header, HEADER.inputSequence, 1);
    }
    Atomics.add(this.#header, HEADER.sequence, 1);
  }

  tryStatsInto(destination: Int32Array): boolean {
    if (destination.length < PIXEL_WORKER_STATS_WORDS) {
      throw new RangeError(`pixel worker stats must contain ${PIXEL_WORKER_STATS_WORDS} words`);
    }
    const before = Atomics.load(this.#header, HEADER.sequence);
    if ((before & 1) !== 0) return false;
    destination[0] = Atomics.load(this.#header, HEADER.tick);
    destination[1] = Atomics.load(this.#header, HEADER.computeMicros);
    destination[2] = Atomics.load(this.#header, HEADER.renderMicros);
    destination[3] = Atomics.load(this.#header, HEADER.activeChunks);
    destination[4] = Atomics.load(this.#header, HEADER.running);
    destination[5] = Atomics.load(this.#header, HEADER.inputTimeMicros);
    destination[6] = Atomics.load(this.#header, HEADER.inputSequence);
    destination[7] = Atomics.load(this.#header, HEADER.rate);
    const after = Atomics.load(this.#header, HEADER.sequence);
    return before === after && (after & 1) === 0;
  }
}

function clampMicros(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(0x7fff_ffff, Math.round(value))) | 0;
}
