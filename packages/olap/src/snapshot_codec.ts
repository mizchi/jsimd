const MAGIC = 0x4d49_534a;
const VERSION = 1;
const FIXED_HEADER_BYTES = 16;
const ADAPTIVE_I32_COLUMN_KIND = 9;

export interface DecodedAdaptiveI32Snapshot {
  readonly shape: Uint32Array;
  readonly payloads: readonly Uint8Array[];
}

/** Private reader for the versioned AdaptiveI32Column snapshot contract. */
export function decodeAdaptiveI32Snapshot(
  snapshot: Uint8Array,
): DecodedAdaptiveI32Snapshot {
  if (!(snapshot instanceof Uint8Array)) throw new TypeError("snapshot must be a Uint8Array");
  if (snapshot.byteLength < FIXED_HEADER_BYTES) throw invalidSnapshot("truncated header");
  const view = new DataView(snapshot.buffer, snapshot.byteOffset, snapshot.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw invalidSnapshot("invalid magic");
  if (view.getUint16(4, true) !== VERSION) throw invalidSnapshot("unsupported version");
  if (view.getUint16(6, true) !== ADAPTIVE_I32_COLUMN_KIND) {
    throw invalidSnapshot("incompatible kind");
  }
  const shapeFields = view.getUint16(8, true);
  const payloadCount = view.getUint16(10, true);
  if (shapeFields !== 2 || payloadCount !== 2) throw invalidSnapshot("incompatible layout");
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

export function invalidSnapshot(reason: string): RangeError {
  return new RangeError(`invalid snapshot: ${reason}`);
}
