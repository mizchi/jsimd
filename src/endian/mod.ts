import { byte_swap32, memory } from "./kernels.wasm";

const nativeLittleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
let wasmBytes = new Uint8Array(memory.buffer);

function ensureCapacity(length: number): void {
  if (length <= wasmBytes.length) return;
  memory.grow(Math.ceil((length - wasmBytes.length) / 65_536));
  wasmBytes = new Uint8Array(memory.buffer);
}

function validateUint32Input(input: Uint8Array): void {
  if ((input.byteLength & 3) !== 0) {
    throw new RangeError("input byte length must be a multiple of four");
  }
}

function scalarDecodeUint32(input: Uint8Array, littleEndian: boolean): Uint32Array {
  const output = new Uint32Array(input.byteLength >>> 2);
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  for (let index = 0; index < output.length; index++) {
    output[index] = view.getUint32(index << 2, littleEndian);
  }
  return output;
}

/** Decode a complete batch of little-endian unsigned 32-bit integers. */
export function decodeUint32LE(input: Uint8Array): Uint32Array {
  validateUint32Input(input);
  if (input.byteLength === 0) return new Uint32Array();
  if (!nativeLittleEndian) return scalarDecodeUint32(input, true);
  const bytes = input.slice();
  return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 2);
}

/** Decode a complete batch of big-endian unsigned 32-bit integers. */
export function decodeUint32BE(input: Uint8Array): Uint32Array {
  validateUint32Input(input);
  if (input.byteLength < 512 || !nativeLittleEndian) {
    return scalarDecodeUint32(input, false);
  }
  ensureCapacity(input.byteLength);
  wasmBytes.set(input, 0);
  byte_swap32(0, input.byteLength);
  return new Uint32Array(memory.buffer, 0, input.byteLength >>> 2).slice();
}
