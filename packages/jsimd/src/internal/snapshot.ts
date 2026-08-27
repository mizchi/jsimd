const MAGIC = 0x4d49_534a; // "JSIM" when encoded little-endian.
const VERSION = 1;
const FIXED_HEADER_BYTES = 16;
const MAX_FIELDS = 64;
const UINT32_LIMIT = 0x1_0000_0000;

export const SnapshotKind = Object.freeze(
  {
    FmIndexBytes: 1,
    WaveletMatrixUint8: 2,
    WaveletMatrixUint32: 3,
    StaticMphfU32: 4,
    CompressedStringTable: 5,
    EliasFanoSequence: 6,
    BinaryVectorIndex: 7,
    WaveletMatrixUint16: 8,
    AdaptiveI32Column: 9,
    AdaptiveU32Column: 10,
    BitSlicedU8Column: 11,
  } as const,
);

export type SnapshotKind = typeof SnapshotKind[keyof typeof SnapshotKind];

export interface DecodedSnapshot {
  readonly shape: Uint32Array;
  readonly payloads: readonly Uint8Array[];
}

export function encodeSnapshot(
  kind: SnapshotKind,
  shape: readonly number[],
  payloads: readonly Uint8Array[],
): Uint8Array {
  if (shape.length > MAX_FIELDS || payloads.length > MAX_FIELDS) {
    throw new RangeError("snapshot has too many fields");
  }
  let total = FIXED_HEADER_BYTES + (shape.length + payloads.length) * 4;
  for (const value of shape) validateUint32(value, "snapshot shape");
  for (const payload of payloads) {
    if (!(payload instanceof Uint8Array)) throw new TypeError("snapshot payload must be bytes");
    total += payload.byteLength;
    if (!Number.isSafeInteger(total) || total >= UINT32_LIMIT) {
      throw new RangeError("snapshot is too large");
    }
  }

  const output = new Uint8Array(total);
  const view = new DataView(output.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint16(4, VERSION, true);
  view.setUint16(6, kind, true);
  view.setUint16(8, shape.length, true);
  view.setUint16(10, payloads.length, true);
  view.setUint32(12, total, true);
  let cursor = FIXED_HEADER_BYTES;
  for (const value of shape) {
    view.setUint32(cursor, value, true);
    cursor += 4;
  }
  for (const payload of payloads) {
    view.setUint32(cursor, payload.byteLength, true);
    cursor += 4;
  }
  for (const payload of payloads) {
    output.set(payload, cursor);
    cursor += payload.byteLength;
  }
  return output;
}

export function decodeSnapshot(
  snapshot: Uint8Array,
  expectedKind: SnapshotKind,
  expectedShapeFields: number,
  expectedPayloads: number,
): DecodedSnapshot {
  if (!(snapshot instanceof Uint8Array)) throw new TypeError("snapshot must be a Uint8Array");
  if (snapshot.byteLength < FIXED_HEADER_BYTES) throw invalidSnapshot("truncated header");
  const view = new DataView(snapshot.buffer, snapshot.byteOffset, snapshot.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw invalidSnapshot("invalid magic");
  if (view.getUint16(4, true) !== VERSION) throw invalidSnapshot("unsupported version");
  if (view.getUint16(6, true) !== expectedKind) throw invalidSnapshot("incompatible kind");
  const shapeFields = view.getUint16(8, true);
  const payloadCount = view.getUint16(10, true);
  if (shapeFields !== expectedShapeFields || payloadCount !== expectedPayloads) {
    throw invalidSnapshot("incompatible layout");
  }
  if (view.getUint32(12, true) !== snapshot.byteLength) {
    throw invalidSnapshot("incorrect byte length");
  }
  const metadataBytes = (shapeFields + payloadCount) * 4;
  const payloadOffset = FIXED_HEADER_BYTES + metadataBytes;
  if (payloadOffset > snapshot.byteLength) throw invalidSnapshot("truncated metadata");

  const shape = new Uint32Array(shapeFields);
  let cursor = FIXED_HEADER_BYTES;
  for (let index = 0; index < shapeFields; index++) {
    shape[index] = view.getUint32(cursor, true);
    cursor += 4;
  }
  const lengths = new Uint32Array(payloadCount);
  let payloadBytes = 0;
  for (let index = 0; index < payloadCount; index++) {
    const length = view.getUint32(cursor, true);
    cursor += 4;
    payloadBytes += length;
    if (!Number.isSafeInteger(payloadBytes) || payloadBytes > snapshot.byteLength - payloadOffset) {
      throw invalidSnapshot("invalid payload lengths");
    }
    lengths[index] = length;
  }
  if (payloadBytes !== snapshot.byteLength - payloadOffset) {
    throw invalidSnapshot("payload lengths do not cover the snapshot");
  }

  const payloads: Uint8Array[] = [];
  cursor = payloadOffset;
  for (const length of lengths) {
    payloads.push(snapshot.subarray(cursor, cursor + length));
    cursor += length;
  }
  return { shape, payloads };
}

export function uint32Payload(payload: Uint8Array, name: string): Uint32Array {
  if ((payload.byteLength & 3) !== 0) throw invalidSnapshot(`${name} is not Uint32-aligned`);
  if ((payload.byteOffset & 3) === 0) {
    return new Uint32Array(payload.buffer, payload.byteOffset, payload.byteLength >>> 2);
  }
  return new Uint32Array(payload.slice().buffer);
}

export function int32Payload(payload: Uint8Array, name: string): Int32Array {
  if ((payload.byteLength & 3) !== 0) throw invalidSnapshot(`${name} is not Int32-aligned`);
  if ((payload.byteOffset & 3) === 0) {
    return new Int32Array(payload.buffer, payload.byteOffset, payload.byteLength >>> 2);
  }
  return new Int32Array(payload.slice().buffer);
}

export function uint16Payload(payload: Uint8Array, name: string): Uint16Array {
  if ((payload.byteLength & 1) !== 0) throw invalidSnapshot(`${name} is not Uint16-aligned`);
  if ((payload.byteOffset & 1) === 0) {
    return new Uint16Array(payload.buffer, payload.byteOffset, payload.byteLength >>> 1);
  }
  return new Uint16Array(payload.slice().buffer);
}

export function expectPayloadBytes(
  payload: Uint8Array,
  expectedBytes: number,
  name: string,
): void {
  if (payload.byteLength !== expectedBytes) {
    throw invalidSnapshot(`invalid ${name} byte length`);
  }
}

export function validateWaveletPayloads(
  length: number,
  levels: number,
  paddedWords: number,
  superblocks: number,
  bitsPayload: Uint8Array,
  ranksPayload: Uint8Array,
  zerosPayload: Uint8Array,
): void {
  const bits = uint32Payload(bitsPayload, "wavelet bits");
  const ranks = uint32Payload(ranksPayload, "wavelet ranks");
  const zeros = uint32Payload(zerosPayload, "wavelet zeros");
  const logicalWords = Math.ceil(length / 32);
  const tailBits = length & 31;
  const tailMask = tailBits === 0 ? 0xffff_ffff : 0xffff_ffff >>> (32 - tailBits);
  for (let level = 0; level < levels; level++) {
    const bitsBase = level * paddedWords;
    const ranksBase = level * (superblocks + 1);
    let ones = 0;
    for (let superblock = 0; superblock < superblocks; superblock++) {
      if (ranks[ranksBase + superblock] !== ones) {
        throw invalidSnapshot("invalid wavelet rank prefix");
      }
      const end = Math.min((superblock + 1) * 16, paddedWords);
      for (let word = superblock * 16; word < end; word++) {
        const value = bits[bitsBase + word]!;
        if (word >= logicalWords && value !== 0) {
          throw invalidSnapshot("set wavelet bits in padding");
        }
        if (word === logicalWords - 1 && (value & ~tailMask) !== 0) {
          throw invalidSnapshot("set wavelet bits outside the logical length");
        }
        ones += popcount32(value);
      }
    }
    if (ranks[ranksBase + superblocks] !== ones || zeros[level] !== length - ones) {
      throw invalidSnapshot("invalid wavelet level metadata");
    }
  }
}

export function invalidSnapshot(reason: string): RangeError {
  return new RangeError(`invalid snapshot: ${reason}`);
}

function validateUint32(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value >= UINT32_LIMIT) {
    throw new RangeError(`${name} must contain unsigned 32-bit integers`);
  }
}

function popcount32(value: number): number {
  value -= (value >>> 1) & 0x5555_5555;
  value = (value & 0x3333_3333) + ((value >>> 2) & 0x3333_3333);
  return Math.imul((value + (value >>> 4)) & 0x0f0f_0f0f, 0x0101_0101) >>> 24;
}
