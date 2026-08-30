/** Runtime representation emitted for MoonBit `ArrayView[Byte]` on the JS target. */
export interface MoonBitByteArrayView {
  readonly buf: ReadonlyArray<number>;
  readonly start: number;
  readonly end: number;
}

export type ByteArrayInput = MoonBitByteArrayView;

/** Find a byte in an ArrayView without materializing a typed array. */
export function arrayViewFindByte(input: ByteArrayInput, needle: number): number {
  validateByte(needle);
  const found = input.buf.indexOf(needle, input.start);
  return found >= input.start && found < input.end ? found - input.start : -1;
}

/** Reverse-find a byte in an ArrayView. */
export function arrayViewRevFindByte(input: ByteArrayInput, needle: number): number {
  validateByte(needle);
  const found = input.buf.lastIndexOf(needle, input.end - 1);
  return found >= input.start ? found - input.start : -1;
}

/** Find a byte sequence in an ArrayView. */
export function arrayViewFind(input: ByteArrayInput, needle: ByteArrayInput): number {
  const needleLength = needle.end - needle.start;
  const inputLength = input.end - input.start;
  if (needleLength === 0) return 0;
  if (needleLength > inputLength) return -1;
  const first = needle.buf[needle.start]!;
  let found = input.buf.indexOf(first, input.start);
  while (found >= input.start && found <= input.end - needleLength) {
    let offset = 1;
    while (
      offset < needleLength && input.buf[found + offset] === needle.buf[needle.start + offset]
    ) offset++;
    if (offset === needleLength) return found - input.start;
    found = input.buf.indexOf(first, found + 1);
  }
  return -1;
}

/** Reverse-find a byte sequence in an ArrayView. */
export function arrayViewRevFind(input: ByteArrayInput, needle: ByteArrayInput): number {
  const needleLength = needle.end - needle.start;
  const inputLength = input.end - input.start;
  if (needleLength === 0) return inputLength;
  if (needleLength > inputLength) return -1;
  const first = needle.buf[needle.start]!;
  let found = input.buf.lastIndexOf(first, input.end - needleLength);
  while (found >= input.start) {
    let offset = 1;
    while (
      offset < needleLength && input.buf[found + offset] === needle.buf[needle.start + offset]
    ) offset++;
    if (offset === needleLength) return found - input.start;
    found = input.buf.lastIndexOf(first, found - 1);
  }
  return -1;
}

function validateByte(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError("needle must be a byte");
  }
}
