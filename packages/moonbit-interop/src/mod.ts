import {
  compare as compareLexicographically,
  equals,
  indexOf,
  indexOfNonAscii,
  lastIndexOf,
} from "@mizchi/jsimd/bytes";

export * from "./array_view.ts";
export * from "./string_view.ts";

/** Runtime representation emitted for MoonBit `BytesView` on the JS target. */
export interface MoonBitBytesView {
  readonly buf: Uint8Array;
  readonly start: number;
  readonly end: number;
}

export type ByteInput = Uint8Array | MoonBitBytesView;

function byteView(input: ByteInput): Uint8Array {
  return input instanceof Uint8Array ? input : input.buf.subarray(input.start, input.end);
}

/** Find a byte and return its input-relative offset, or -1. */
export function findByte(input: ByteInput, needle: number): number {
  return indexOf(byteView(input), needle);
}

/** Find a byte sequence and return its input-relative offset, or -1. */
export function find(input: ByteInput, needle: ByteInput): number {
  return indexOf(byteView(input), byteView(needle));
}

/** Find the last byte and return its input-relative offset, or -1. */
export function revFindByte(input: ByteInput, needle: number): number {
  return lastIndexOf(byteView(input), needle);
}

/** Find the last byte sequence and return its input-relative offset, or -1. */
export function revFind(input: ByteInput, needle: ByteInput): number {
  const inputView = byteView(input);
  const needleView = byteView(needle);
  if (needleView.length === 0) return inputView.length;
  if (needleView.length > inputView.length) return -1;
  if (needleView.length === 1) return lastIndexOf(inputView, needleView[0]!);

  const first = needleView[0]!;
  for (let index = inputView.length - needleView.length; index >= 0; index--) {
    if (inputView[index] !== first) continue;
    let offset = 1;
    while (offset < needleView.length && inputView[index + offset] === needleView[offset]) offset++;
    if (offset === needleView.length) return index;
  }
  return -1;
}

/** Return the first non-ASCII byte offset, or -1. */
export function findNonAscii(input: ByteInput): number {
  return indexOfNonAscii(byteView(input));
}

/** Return whether both byte sequences contain the same bytes. */
export function equal(left: ByteInput, right: ByteInput): boolean {
  return equals(byteView(left), byteView(right));
}

/** Compare two byte sequences using MoonBit Bytes shortlex ordering. */
export function compare(left: ByteInput, right: ByteInput): number {
  const leftView = byteView(left);
  const rightView = byteView(right);
  const lengthDifference = leftView.length - rightView.length;
  if (lengthDifference !== 0) return Math.sign(lengthDifference);
  return Math.sign(compareLexicographically(leftView, rightView));
}
