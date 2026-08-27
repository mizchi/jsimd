import type { ColumnDefinition } from "./schema.ts";

const MAGIC = 0x5043_534a;
const VERSION = 1;
const HEADER_BYTES = 24;

export function encodeColumnPage(
  definition: ColumnDefinition,
  values: Int32Array | Uint32Array | Uint8Array,
): Uint8Array {
  validateTypedArray(definition, values);
  const elementBytes = definition.kind === "u8" ? 1 : 4;
  const output = new Uint8Array(HEADER_BYTES + values.length * elementBytes);
  const view = new DataView(output.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint16(4, VERSION, true);
  view.setUint8(6, kindCode(definition));
  view.setUint8(7, definition.kind === "u8" ? definition.bitWidth : 32);
  view.setUint32(8, values.length, true);
  view.setUint32(12, values.length * elementBytes, true);
  for (let index = 0; index < values.length; index++) {
    const offset = HEADER_BYTES + index * elementBytes;
    if (definition.kind === "i32") view.setInt32(offset, values[index]!, true);
    else if (definition.kind === "u32") view.setUint32(offset, values[index]!, true);
    else view.setUint8(offset, values[index]!);
  }
  view.setUint32(16, checksum(output.subarray(HEADER_BYTES)), true);
  return output;
}

export function decodeColumnPage(
  definition: ColumnDefinition,
  bytes: Uint8Array,
): Int32Array | Uint32Array | Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < HEADER_BYTES) {
    throw new RangeError("column page is truncated");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw new RangeError("invalid column page magic");
  if (view.getUint16(4, true) !== VERSION) throw new RangeError("unsupported column page version");
  if (view.getUint8(6) !== kindCode(definition)) throw new RangeError("column page kind mismatch");
  const bitWidth = view.getUint8(7);
  if (definition.kind === "u8" && bitWidth !== definition.bitWidth) {
    throw new RangeError("column page bit width mismatch");
  }
  const length = view.getUint32(8, true);
  const payloadBytes = view.getUint32(12, true);
  const elementBytes = definition.kind === "u8" ? 1 : 4;
  if (payloadBytes !== length * elementBytes || bytes.byteLength !== HEADER_BYTES + payloadBytes) {
    throw new RangeError("column page payload length mismatch");
  }
  const payload = bytes.subarray(HEADER_BYTES);
  if (view.getUint32(16, true) !== checksum(payload)) {
    throw new RangeError("column page checksum mismatch");
  }
  if (definition.kind === "u8") return payload.slice();
  const values = definition.kind === "i32" ? new Int32Array(length) : new Uint32Array(length);
  for (let index = 0; index < length; index++) {
    values[index] = definition.kind === "i32"
      ? view.getInt32(HEADER_BYTES + index * 4, true)
      : view.getUint32(HEADER_BYTES + index * 4, true);
  }
  return values;
}

function validateTypedArray(
  definition: ColumnDefinition,
  values: Int32Array | Uint32Array | Uint8Array,
): void {
  const valid = definition.kind === "i32"
    ? values instanceof Int32Array
    : definition.kind === "u32"
    ? values instanceof Uint32Array
    : values instanceof Uint8Array;
  if (!valid) throw new TypeError(`column ${definition.kind} received an incompatible typed array`);
  if (definition.kind === "u8") {
    const limit = 2 ** definition.bitWidth;
    for (const value of values) {
      if (value >= limit) {
        throw new RangeError(`u8 value ${value} exceeds ${definition.bitWidth} bits`);
      }
    }
  }
}

function kindCode(definition: ColumnDefinition): number {
  if (definition.kind === "i32") return 1;
  if (definition.kind === "u32") return 2;
  return 3;
}

function checksum(bytes: Uint8Array): number {
  let hash = 0x811c_9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x0100_0193) >>> 0;
  return hash;
}
