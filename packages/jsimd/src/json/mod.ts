import { json_token_starts, memory } from "./kernels.wasm";

let wasmBytes = new Uint8Array(memory.buffer);

function ensureCapacity(length: number): void {
  if (length <= wasmBytes.length) return;
  memory.grow(Math.ceil((length - wasmBytes.length) / 65_536));
  wasmBytes = new Uint8Array(memory.buffer);
}

/** Return UTF-8 byte offsets for JSON structural tokens, quotes, and atom starts. */
export function jsonTokenStarts(input: Uint8Array): Uint32Array {
  if (input.length === 0) return new Uint32Array();
  const outputPointer = (input.length + 3) & ~3;
  ensureCapacity(outputPointer + input.length * 4);
  wasmBytes.set(input, 0);
  const count = json_token_starts(0, input.length, outputPointer);
  // Copy out because the shared scratch memory is overwritten by the next call.
  return new Uint32Array(memory.buffer, outputPointer, count).slice();
}
