import {
  bytes_equal,
  find_byte,
  find_non_ascii,
  index_of_subarray,
  json_token_starts,
  lexical_compare_prefix,
  memory,
  reverse_find_byte,
} from "./kernels.wasm";

let wasmBytes = new Uint8Array(memory.buffer);

function ensureCapacity(length: number): void {
  if (length <= wasmBytes.length) return;
  memory.grow(Math.ceil((length - wasmBytes.length) / 65_536));
  wasmBytes = new Uint8Array(memory.buffer);
}

function scratchPointer(length: number): number {
  ensureCapacity(length);
  return 0;
}

/** Find a byte and return its input-relative index, or -1. */
export function findByte(
  input: Uint8Array,
  needle: number,
  start = 0,
  end = input.length,
): number {
  if (!Number.isInteger(needle) || needle < 0 || needle > 0xff) {
    throw new RangeError("needle must be an integer between 0 and 255");
  }
  if (
    !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end ||
    end > input.length
  ) {
    throw new RangeError("expected 0 <= start <= end <= input.length");
  }
  const length = end - start;
  // Copying a tiny input costs more than the vector scan can recover.
  if (length < 128) {
    const found = input.subarray(start, end).indexOf(needle);
    return found < 0 ? -1 : start + found;
  }
  const simdStart = start + 16;
  const prefixFound = input.subarray(start, simdStart).indexOf(needle);
  if (prefixFound >= 0) return start + prefixFound;
  const simdLength = end - simdStart;
  const pointer = scratchPointer(simdLength);
  wasmBytes.set(input.subarray(simdStart, end), pointer);
  const found = find_byte(pointer, simdLength, needle);
  return found < 0 ? -1 : simdStart + found;
}

/** Find the last byte and return its input-relative index, or -1. */
export function reverseFindByte(input: Uint8Array, needle: number): number {
  if (!Number.isInteger(needle) || needle < 0 || needle > 0xff) {
    throw new RangeError("needle must be an integer between 0 and 255");
  }
  if (input.length < 128) return input.lastIndexOf(needle);
  const simdEnd = input.length - 16;
  const suffixFound = input.subarray(simdEnd).lastIndexOf(needle);
  if (suffixFound >= 0) return simdEnd + suffixFound;
  const pointer = scratchPointer(simdEnd);
  wasmBytes.set(input.subarray(0, simdEnd), pointer);
  return reverse_find_byte(pointer, simdEnd, needle);
}

/** Return the first non-ASCII byte index, or -1 when all bytes are ASCII. */
export function findNonAscii(input: Uint8Array): number {
  if (input.length < 128) {
    for (let index = 0; index < input.length; index++) {
      if (input[index]! >= 0x80) return index;
    }
    return -1;
  }
  for (let index = 0; index < 16; index++) {
    if (input[index]! >= 0x80) return index;
  }
  const simdLength = input.length - 16;
  const pointer = scratchPointer(simdLength);
  wasmBytes.set(input.subarray(16), pointer);
  const found = find_non_ascii(pointer, simdLength);
  return found < 0 ? -1 : found + 16;
}

/** Compare two byte arrays for equality. */
export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  if (left.length < 128) {
    for (let index = 0; index < left.length; index++) {
      if (left[index] !== right[index]) return false;
    }
    return true;
  }
  for (let index = 0; index < 16; index++) {
    if (left[index] !== right[index]) return false;
  }
  const simdLength = left.length - 16;
  const pointer = scratchPointer(simdLength * 2);
  wasmBytes.set(left.subarray(16), pointer);
  wasmBytes.set(right.subarray(16), pointer + simdLength);
  return bytes_equal(pointer, pointer + simdLength, simdLength) !== 0;
}

/** Compare byte arrays in lexicographical order. */
export function lexicalCompare(left: Uint8Array, right: Uint8Array): number {
  const minLength = Math.min(left.length, right.length);
  if (minLength < 128) {
    for (let index = 0; index < minLength; index++) {
      const difference = left[index]! - right[index]!;
      if (difference !== 0) return difference;
    }
    return left.length - right.length;
  }
  for (let index = 0; index < 16; index++) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  const simdLength = minLength - 16;
  const pointer = scratchPointer(simdLength * 2);
  wasmBytes.set(left.subarray(16, minLength), pointer);
  wasmBytes.set(right.subarray(16, minLength), pointer + simdLength);
  const difference = lexical_compare_prefix(pointer, pointer + simdLength, simdLength);
  return difference !== 0 ? difference : left.length - right.length;
}

function scalarIndexOfSubarray(
  input: Uint8Array,
  pattern: Uint8Array,
  start: number,
  end: number,
): number {
  outer:
  for (let index = start; index + pattern.length <= end; index++) {
    for (let offset = 0; offset < pattern.length; offset++) {
      if (input[index + offset] !== pattern[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

/** Find the first occurrence of a byte subarray, or -1. */
export function indexOfSubarray(input: Uint8Array, pattern: Uint8Array): number {
  if (pattern.length === 0) return 0;
  if (pattern.length > input.length) return -1;
  if (pattern.length === 1) return findByte(input, pattern[0]!);
  if (input.length < 128) return scalarIndexOfSubarray(input, pattern, 0, input.length);
  const prefixEnd = Math.min(input.length, 16 + pattern.length - 1);
  const prefixFound = scalarIndexOfSubarray(input, pattern, 0, prefixEnd);
  if (prefixFound >= 0) return prefixFound;
  const remaining = input.subarray(16);
  const pointer = scratchPointer(remaining.length + pattern.length);
  wasmBytes.set(remaining, pointer);
  wasmBytes.set(pattern, pointer + remaining.length);
  const found = index_of_subarray(
    pointer,
    remaining.length,
    pointer + remaining.length,
    pattern.length,
  );
  return found < 0 ? -1 : found + 16;
}

/** Return UTF-8 byte offsets for JSON structural tokens, quotes, and atom starts. */
export function jsonTokenStarts(input: Uint8Array): Uint32Array {
  if (input.length === 0) return new Uint32Array();
  const outputPointer = (input.length + 3) & ~3;
  const pointer = scratchPointer(outputPointer + input.length * 4);
  wasmBytes.set(input, pointer);
  const count = json_token_starts(pointer, input.length, pointer + outputPointer);
  // Copy out because the shared scratch memory is overwritten by the next call.
  return new Uint32Array(memory.buffer, pointer + outputPointer, count).slice();
}
