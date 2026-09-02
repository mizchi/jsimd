export const PIXEL_GPU_EVENT_HEADER_WORDS = 4;
export const PIXEL_GPU_EVENT_RECORD_WORDS = 4;

export interface PixelGpuEventBatch {
  readonly total: number;
  readonly dropped: number;
  readonly tick: number;
  readonly records: Uint32Array;
}

export function pixelGpuEventBytes(capacity: number): number {
  validateCapacity(capacity);
  return (
    PIXEL_GPU_EVENT_HEADER_WORDS + capacity * PIXEL_GPU_EVENT_RECORD_WORDS
  ) * Uint32Array.BYTES_PER_ELEMENT;
}

export function decodePixelGpuEvents(
  words: Uint32Array,
  capacity: number,
): PixelGpuEventBatch {
  validateCapacity(capacity);
  const expectedWords = PIXEL_GPU_EVENT_HEADER_WORDS + capacity * PIXEL_GPU_EVENT_RECORD_WORDS;
  if (words.length !== expectedWords) throw new RangeError("invalid GPU event readback size");
  const total = words[0]! >>> 0;
  const emitted = Math.min(total, capacity);
  return {
    total,
    dropped: words[1]! >>> 0,
    tick: words[2]! >>> 0,
    records: words.slice(
      PIXEL_GPU_EVENT_HEADER_WORDS,
      PIXEL_GPU_EVENT_HEADER_WORDS + emitted * PIXEL_GPU_EVENT_RECORD_WORDS,
    ),
  };
}

function validateCapacity(capacity: number): void {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1_048_576) {
    throw new RangeError("GPU event capacity must be between 1 and 1048576");
  }
}
