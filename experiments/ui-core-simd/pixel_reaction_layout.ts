import { PIXEL_EVENT_RECORD_WORDS } from "./pixel_event_tape.ts";

export function pixelReactionRequiredBytes(
  width: number,
  height: number,
  eventCapacity: number,
): number {
  validateDimensions(width, height, eventCapacity);
  const cellBytes = width * height * Uint32Array.BYTES_PER_ELEMENT;
  return align16(cellBytes) + cellBytes + eventCapacity * PIXEL_EVENT_RECORD_WORDS * 4;
}

export function pixelReactionScratchOffset(width: number, height: number): number {
  return align16(width * height * Uint32Array.BYTES_PER_ELEMENT);
}

function align16(value: number): number {
  return (value + 15) & ~15;
}

function validateDimensions(width: number, height: number, eventCapacity: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new RangeError("reaction dimensions must be positive safe integers");
  }
  if (!Number.isSafeInteger(eventCapacity) || eventCapacity < 1 || eventCapacity > 1_048_576) {
    throw new RangeError("reaction event capacity is invalid");
  }
  const cells = width * height;
  if (!Number.isSafeInteger(cells) || cells > 16_777_216) {
    throw new RangeError("reaction world is too large");
  }
}
