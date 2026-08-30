/** Runtime representation emitted for MoonBit `StringView` on the JS target. */
export interface MoonBitStringView {
  readonly str: string;
  readonly start: number;
  readonly end: number;
}

export type StringInput = string | MoonBitStringView;

function stringRange(input: StringInput): MoonBitStringView {
  return typeof input === "string" ? { str: input, start: 0, end: input.length } : input;
}

function stringText(input: MoonBitStringView): string {
  return input.start === 0 && input.end === input.str.length
    ? input.str
    : input.str.substring(input.start, input.end);
}

/** Find a StringView substring and return a view-relative UTF-16 offset, or -1. */
export function stringViewFind(input: StringInput, needle: StringInput): number {
  const inputRange = stringRange(input);
  const needleRange = stringRange(needle);
  const needleLength = needleRange.end - needleRange.start;
  const inputLength = inputRange.end - inputRange.start;
  if (needleLength === 0) return 0;
  if (needleLength > inputLength) return -1;
  const found = inputRange.str.indexOf(stringText(needleRange), inputRange.start);
  return found >= inputRange.start && found <= inputRange.end - needleLength
    ? found - inputRange.start
    : -1;
}

/** Reverse-find a StringView substring and return a view-relative UTF-16 offset, or -1. */
export function stringViewRevFind(input: StringInput, needle: StringInput): number {
  const inputRange = stringRange(input);
  const needleRange = stringRange(needle);
  const needleLength = needleRange.end - needleRange.start;
  const inputLength = inputRange.end - inputRange.start;
  if (needleLength === 0) return inputLength;
  if (needleLength > inputLength) return -1;
  const found = inputRange.str.lastIndexOf(
    stringText(needleRange),
    inputRange.end - needleLength,
  );
  return found >= inputRange.start ? found - inputRange.start : -1;
}

/** Find one UTF-16 code unit and return a view-relative offset, or -1. */
export function stringViewFindCodeUnit(input: StringInput, needle: number): number {
  validateCodeUnit(needle);
  return stringViewFind(input, String.fromCharCode(needle));
}

/** Reverse-find one UTF-16 code unit and return a view-relative offset, or -1. */
export function stringViewRevFindCodeUnit(input: StringInput, needle: number): number {
  validateCodeUnit(needle);
  return stringViewRevFind(input, String.fromCharCode(needle));
}

/** Compare two StringViews using MoonBit's UTF-16 shortlex ordering. */
export function stringViewCompare(left: StringInput, right: StringInput): number {
  const leftRange = stringRange(left);
  const rightRange = stringRange(right);
  const lengthDifference = leftRange.end - leftRange.start - (rightRange.end - rightRange.start);
  if (lengthDifference !== 0) return Math.sign(lengthDifference);
  const leftText = stringText(leftRange);
  const rightText = stringText(rightRange);
  return leftText === rightText ? 0 : leftText < rightText ? -1 : 1;
}

function validateCodeUnit(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError("needle must be a UTF-16 code unit");
  }
}
