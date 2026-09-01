import type { FixedRect } from "./life_game.ts";

const MAGIC = 0x4c494645;
const VERSION = 1;
const HEADER_WORDS = 20;
const HEADER_BYTES = HEADER_WORDS * Int32Array.BYTES_PER_ELEMENT;

const HEADER = {
  magic: 0,
  version: 1,
  width: 2,
  height: 3,
  sequence: 4,
  front: 5,
  generation: 6,
  liveCount: 7,
  stepMicros: 8,
  running: 9,
  command: 10,
  commandSequence: 11,
  viewportLeft: 12,
  viewportTop: 13,
  viewportWidth: 14,
  viewportHeight: 15,
  rate: 16,
} as const;

export const LIFE_COMMAND = {
  none: 0,
  toggleRunning: 1,
  step: 2,
  randomize: 3,
  clear: 4,
} as const;

export type LifeCommand = (typeof LIFE_COMMAND)[keyof typeof LIFE_COMMAND];

export interface LifeWriteBuffer {
  readonly index: 0 | 1;
  readonly cells: Uint8Array;
}

export class LifeSharedBoard {
  readonly buffer: SharedArrayBuffer;
  readonly width: number;
  readonly height: number;
  readonly cellCount: number;
  readonly #header: Int32Array;
  readonly #boards: readonly [Uint8Array, Uint8Array];

  private constructor(buffer: SharedArrayBuffer) {
    this.buffer = buffer;
    this.#header = new Int32Array(buffer, 0, HEADER_WORDS);
    if (
      this.#header[HEADER.magic] !== MAGIC ||
      this.#header[HEADER.version] !== VERSION
    ) {
      throw new TypeError("invalid life shared-board ABI");
    }
    this.width = this.#header[HEADER.width];
    this.height = this.#header[HEADER.height];
    this.cellCount = this.width * this.height;
    if (
      this.width <= 0 ||
      this.height <= 0 ||
      buffer.byteLength !== HEADER_BYTES + this.cellCount * 2
    ) {
      throw new TypeError("invalid life shared-board dimensions");
    }
    this.#boards = [
      new Uint8Array(buffer, HEADER_BYTES, this.cellCount),
      new Uint8Array(buffer, HEADER_BYTES + this.cellCount, this.cellCount),
    ];
  }

  static create(width: number, height: number): LifeSharedBoard {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new RangeError("life board dimensions must be positive integers");
    }
    const cellCount = width * height;
    if (!Number.isSafeInteger(cellCount) || cellCount > 16_777_216) {
      throw new RangeError("life board is too large");
    }
    const buffer = new SharedArrayBuffer(HEADER_BYTES + cellCount * 2);
    const header = new Int32Array(buffer, 0, HEADER_WORDS);
    header[HEADER.magic] = MAGIC;
    header[HEADER.version] = VERSION;
    header[HEADER.width] = width;
    header[HEADER.height] = height;
    header[HEADER.running] = 1;
    header[HEADER.rate] = 30;
    return new LifeSharedBoard(buffer);
  }

  static attach(buffer: SharedArrayBuffer): LifeSharedBoard {
    if (buffer.byteLength < HEADER_BYTES) throw new TypeError("life shared-board is truncated");
    return new LifeSharedBoard(buffer);
  }

  get generation(): number {
    return Atomics.load(this.#header, HEADER.generation) >>> 0;
  }

  get liveCount(): number {
    return Atomics.load(this.#header, HEADER.liveCount) >>> 0;
  }

  get stepMicros(): number {
    return Atomics.load(this.#header, HEADER.stepMicros) >>> 0;
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
    if (!Number.isFinite(rate)) throw new TypeError("life rate must be finite");
    Atomics.store(this.#header, HEADER.rate, Math.max(1, Math.min(120, Math.round(rate))));
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

  get command(): LifeCommand {
    return Atomics.load(this.#header, HEADER.command) as LifeCommand;
  }

  get commandSequence(): number {
    return Atomics.load(this.#header, HEADER.commandSequence) >>> 0;
  }

  issueCommand(command: LifeCommand): number {
    Atomics.store(this.#header, HEADER.command, command);
    return Atomics.add(this.#header, HEADER.commandSequence, 1) + 1;
  }

  beginWrite(): LifeWriteBuffer {
    const sequence = Atomics.add(this.#header, HEADER.sequence, 1);
    if ((sequence & 1) !== 0) {
      Atomics.sub(this.#header, HEADER.sequence, 1);
      throw new Error("life shared-board already has an active writer");
    }
    const index = (1 - Atomics.load(this.#header, HEADER.front)) as 0 | 1;
    return { index, cells: this.#boards[index] };
  }

  publish(index: 0 | 1, liveCount: number, stepMicros: number): void {
    if ((Atomics.load(this.#header, HEADER.sequence) & 1) === 0) {
      throw new Error("life shared-board publish requires beginWrite");
    }
    Atomics.store(this.#header, HEADER.liveCount, liveCount | 0);
    Atomics.store(this.#header, HEADER.stepMicros, Math.max(0, Math.round(stepMicros)) | 0);
    Atomics.store(this.#header, HEADER.front, index);
    Atomics.add(this.#header, HEADER.generation, 1);
    Atomics.add(this.#header, HEADER.sequence, 1);
  }

  copyFrontInto(destination: Uint8Array): void {
    if (destination.length !== this.cellCount) {
      throw new RangeError(`life snapshot must contain ${this.cellCount} cells`);
    }
    destination.set(this.#boards[Atomics.load(this.#header, HEADER.front)]);
  }

  trySnapshotInto(destination: Uint8Array): boolean {
    if (destination.length !== this.cellCount) {
      throw new RangeError(`life snapshot must contain ${this.cellCount} cells`);
    }
    const before = Atomics.load(this.#header, HEADER.sequence);
    if ((before & 1) !== 0) return false;
    destination.set(this.#boards[Atomics.load(this.#header, HEADER.front)]);
    const after = Atomics.load(this.#header, HEADER.sequence);
    return before === after && (after & 1) === 0;
  }
}
