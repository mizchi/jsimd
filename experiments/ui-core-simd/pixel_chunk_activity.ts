const HOT_PHASES = 2;

export interface PixelChunkBounds {
  readonly index: number;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Owns sparse scheduling state without depending on cell materials or movement rules. */
export class PixelChunkActivity {
  readonly width: number;
  readonly height: number;
  readonly chunkSize: number;
  readonly chunksX: number;
  readonly chunksY: number;
  readonly chunkCount: number;
  #current: Uint8Array;
  #next: Uint8Array;
  readonly #expandedNext: Uint8Array;

  constructor(width: number, height: number, chunkSize = 32) {
    positiveInteger(width, "width");
    positiveInteger(height, "height");
    positiveInteger(chunkSize, "chunkSize");
    this.width = width;
    this.height = height;
    this.chunkSize = chunkSize;
    this.chunksX = Math.ceil(width / chunkSize);
    this.chunksY = Math.ceil(height / chunkSize);
    this.chunkCount = this.chunksX * this.chunksY;
    this.#current = new Uint8Array(this.chunkCount);
    this.#next = new Uint8Array(this.chunkCount);
    this.#expandedNext = new Uint8Array(this.chunkCount);
  }

  get activeChunkCount(): number {
    let count = 0;
    for (let index = 0; index < this.#current.length; index++) {
      if (this.#current[index] !== 0) count++;
    }
    return count;
  }

  activateCell(x: number, y: number): void {
    this.#activateNeighborhood(this.#current, this.#chunkX(x), this.#chunkY(y));
  }

  activateRect(left: number, top: number, right: number, bottom: number): void {
    const startX = this.#chunkX(Math.min(left, right));
    const endX = this.#chunkX(Math.max(left, right));
    const startY = this.#chunkY(Math.min(top, bottom));
    const endY = this.#chunkY(Math.max(top, bottom));
    for (let chunkY = startY; chunkY <= endY; chunkY++) {
      for (let chunkX = startX; chunkX <= endX; chunkX++) {
        this.#activateNeighborhood(this.#current, chunkX, chunkY);
      }
    }
  }

  beginStep(): void {
    this.#next.fill(0);
    this.#expandedNext.fill(0);
  }

  markMoved(firstIndex: number, secondIndex: number): void {
    this.#activateIndex(this.#next, firstIndex);
    this.#activateIndex(this.#next, secondIndex);
  }

  /** Keeps an owner chunk and its one-chunk halo hot without exposing moved cell coordinates. */
  markChunkHot(index: number): void {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.chunkCount) {
      throw new RangeError("pixel chunk index is outside the activity grid");
    }
    if (this.#expandedNext[index] !== 0) return;
    this.#expandedNext[index] = 1;
    this.#activateNeighborhood(this.#next, index % this.chunksX, Math.floor(index / this.chunksX));
  }

  finishStep(): void {
    for (let index = 0; index < this.#current.length; index++) {
      if (this.#next[index] === 0 && this.#current[index]! > 1) {
        this.#next[index] = this.#current[index]! - 1;
      }
    }
    [this.#current, this.#next] = [this.#next, this.#current];
  }

  forEachActiveChunk(visit: (bounds: PixelChunkBounds) => void): void {
    for (let index = 0; index < this.#current.length; index++) {
      if (this.#current[index] === 0) continue;
      const chunkX = index % this.chunksX;
      const chunkY = Math.floor(index / this.chunksX);
      const left = chunkX * this.chunkSize;
      const top = chunkY * this.chunkSize;
      visit({
        index,
        left,
        top,
        right: Math.min(this.width, left + this.chunkSize),
        bottom: Math.min(this.height, top + this.chunkSize),
      });
    }
  }

  #activateIndex(target: Uint8Array, index: number): void {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.width * this.height) {
      throw new RangeError("pixel index is outside the chunk world");
    }
    const x = index % this.width;
    const y = Math.floor(index / this.width);
    const chunkX = Math.floor(x / this.chunkSize);
    const chunkY = Math.floor(y / this.chunkSize);
    const chunkIndex = chunkY * this.chunksX + chunkX;
    if (target === this.#next && this.#expandedNext[chunkIndex] !== 0) return;
    if (target === this.#next) this.#expandedNext[chunkIndex] = 1;
    this.#activateNeighborhood(target, chunkX, chunkY);
  }

  #activateNeighborhood(target: Uint8Array, centerX: number, centerY: number): void {
    for (
      let chunkY = Math.max(0, centerY - 1);
      chunkY <= Math.min(this.chunksY - 1, centerY + 1);
      chunkY++
    ) {
      for (
        let chunkX = Math.max(0, centerX - 1);
        chunkX <= Math.min(this.chunksX - 1, centerX + 1);
        chunkX++
      ) {
        target[chunkY * this.chunksX + chunkX] = HOT_PHASES;
      }
    }
  }

  #chunkX(x: number): number {
    return Math.floor(clampCoordinate(x, this.width) / this.chunkSize);
  }

  #chunkY(y: number): number {
    return Math.floor(clampCoordinate(y, this.height) / this.chunkSize);
  }
}

function clampCoordinate(value: number, limit: number): number {
  if (!Number.isFinite(value)) throw new RangeError("chunk coordinate must be finite");
  return Math.max(0, Math.min(limit - 1, Math.floor(value)));
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}
