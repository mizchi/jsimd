import {
  bytesEqual,
  findByte,
  findNonAscii,
  indexOfSubarray,
  lexicalCompare,
  reverseFindByte,
} from "./operations.ts";

export type BytesViewSource = ArrayBufferLike | ArrayBufferView;
export type BytesLike = Uint8Array | BytesView;

function checkedRange(
  totalLength: number,
  byteOffset: number,
  byteLength: number | undefined,
): { byteOffset: number; byteLength: number } {
  if (!Number.isInteger(byteOffset) || byteOffset < 0 || byteOffset > totalLength) {
    throw new RangeError("byteOffset must be an integer within the source view");
  }
  const resolvedLength = byteLength ?? totalLength - byteOffset;
  if (
    !Number.isInteger(resolvedLength) || resolvedLength < 0 ||
    resolvedLength > totalLength - byteOffset
  ) {
    throw new RangeError("byteLength must fit within the source view");
  }
  return { byteOffset, byteLength: resolvedLength };
}

/**
 * A zero-copy, read-only byte range with DataView-compatible typed reads and
 * SIMD-backed bulk operations.
 */
export class BytesView {
  readonly buffer: ArrayBufferLike;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly #bytes: Uint8Array;
  readonly #data: DataView;

  constructor(source: BytesViewSource, byteOffset = 0, byteLength?: number) {
    const sourceBuffer = ArrayBuffer.isView(source) ? source.buffer : source;
    const sourceOffset = ArrayBuffer.isView(source) ? source.byteOffset : 0;
    const sourceLength = ArrayBuffer.isView(source) ? source.byteLength : source.byteLength;
    const range = checkedRange(sourceLength, byteOffset, byteLength);
    this.buffer = sourceBuffer;
    this.byteOffset = sourceOffset + range.byteOffset;
    this.byteLength = range.byteLength;
    this.#bytes = new Uint8Array(this.buffer, this.byteOffset, this.byteLength);
    this.#data = new DataView(this.buffer, this.byteOffset, this.byteLength);
  }

  get length(): number {
    return this.byteLength;
  }

  get(index: number): number | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= this.byteLength) return undefined;
    return this.#bytes[index];
  }

  at(index: number): number {
    const value = this.get(index);
    if (value === undefined) throw new RangeError("byte index is outside the view");
    return value;
  }

  /** Create a zero-copy range relative to this view. */
  view(start = 0, end = this.byteLength): BytesView {
    if (!Number.isInteger(end) || end < start) {
      throw new RangeError("expected start <= end");
    }
    const range = checkedRange(this.byteLength, start, end - start);
    return new BytesView(this.#bytes, range.byteOffset, range.byteLength);
  }

  /** Copy the visible range into an independently owned array. */
  toUint8Array(): Uint8Array {
    return this.#bytes.slice();
  }

  findByte(needle: number, start = 0, end = this.byteLength): number {
    return findByte(this.#bytes, needle, start, end);
  }

  reverseFindByte(needle: number): number {
    return reverseFindByte(this.#bytes, needle);
  }

  findNonAscii(): number {
    return findNonAscii(this.#bytes);
  }

  find(pattern: BytesLike): number {
    return indexOfSubarray(this.#bytes, this.#resolve(pattern));
  }

  equals(other: BytesLike): boolean {
    return bytesEqual(this.#bytes, this.#resolve(other));
  }

  compare(other: BytesLike): number {
    return lexicalCompare(this.#bytes, this.#resolve(other));
  }

  hasPrefix(prefix: BytesLike): boolean {
    const bytes = this.#resolve(prefix);
    return bytes.length <= this.byteLength &&
      bytesEqual(this.#bytes.subarray(0, bytes.length), bytes);
  }

  hasSuffix(suffix: BytesLike): boolean {
    const bytes = this.#resolve(suffix);
    return bytes.length <= this.byteLength &&
      bytesEqual(this.#bytes.subarray(this.byteLength - bytes.length), bytes);
  }

  getInt8(byteOffset: number): number {
    return this.#data.getInt8(byteOffset);
  }

  getUint8(byteOffset: number): number {
    return this.#data.getUint8(byteOffset);
  }

  getInt16(byteOffset: number, littleEndian = false): number {
    return this.#data.getInt16(byteOffset, littleEndian);
  }

  getUint16(byteOffset: number, littleEndian = false): number {
    return this.#data.getUint16(byteOffset, littleEndian);
  }

  getInt32(byteOffset: number, littleEndian = false): number {
    return this.#data.getInt32(byteOffset, littleEndian);
  }

  getUint32(byteOffset: number, littleEndian = false): number {
    return this.#data.getUint32(byteOffset, littleEndian);
  }

  getBigInt64(byteOffset: number, littleEndian = false): bigint {
    return this.#data.getBigInt64(byteOffset, littleEndian);
  }

  getBigUint64(byteOffset: number, littleEndian = false): bigint {
    return this.#data.getBigUint64(byteOffset, littleEndian);
  }

  getFloat32(byteOffset: number, littleEndian = false): number {
    return this.#data.getFloat32(byteOffset, littleEndian);
  }

  getFloat64(byteOffset: number, littleEndian = false): number {
    return this.#data.getFloat64(byteOffset, littleEndian);
  }

  #resolve(other: BytesLike): Uint8Array {
    return other instanceof BytesView ? other.#bytes : other;
  }
}
