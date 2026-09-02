const MATERIAL_BYTES = 16;
const RULE_BYTES = 16;
const EVENT_RECORD_BYTES = 16;
const EVENT_HEADER_BYTES = 32;
const WASM_PAGE_BYTES = 65_536;
const CHUNK_SIZE = 32;

export interface PixelFieldBuffer {
  readonly bytesPerCell: 1 | 2 | 4;
  readonly buffers: 1 | 2;
}

export interface PixelRuleBufferInput {
  readonly width: number;
  readonly height: number;
  readonly materialCount: number;
  readonly ruleCount: number;
  readonly eventCapacity: number;
  readonly fields: readonly PixelFieldBuffer[];
}

export interface PixelRuleBufferPlan {
  readonly cellBytes: number;
  readonly sharedScratchBytes: number;
  readonly materialTableBytes: number;
  readonly ruleTableBytes: number;
  readonly fieldBytes: number;
  readonly wasmEventBytes: number;
  readonly sharedEventBytes: number;
  readonly mainEventDrainBytes: number;
  readonly activeChunkBytes: number;
  readonly presentationBytes: number;
  readonly wasmBytes: number;
  readonly wasmRoundedBytes: number;
  readonly totalOwnedBytes: number;
}

/** Models explicitly owned buffers; browser compositor and canvas backing stores are excluded. */
export function planPixelRuleBuffers(input: PixelRuleBufferInput): PixelRuleBufferPlan {
  positiveInteger(input.width, "width");
  positiveInteger(input.height, "height");
  boundedInteger(input.materialCount, 1, 256, "materialCount");
  boundedInteger(input.ruleCount, 1, 4_096, "ruleCount");
  boundedInteger(input.eventCapacity, 2, 1_048_576, "eventCapacity");
  if ((input.eventCapacity & (input.eventCapacity - 1)) !== 0) {
    throw new RangeError("eventCapacity must be a power of two");
  }
  const cells = input.width * input.height;
  if (!Number.isSafeInteger(cells) || cells > 16_777_216) {
    throw new RangeError("pixel world is too large");
  }
  let fieldBytes = 0;
  for (const field of input.fields) {
    if (
      (field.bytesPerCell !== 1 && field.bytesPerCell !== 2 && field.bytesPerCell !== 4) ||
      (field.buffers !== 1 && field.buffers !== 2)
    ) throw new RangeError("field storage must use one or two byte-addressable buffers");
    fieldBytes += cells * field.bytesPerCell * field.buffers;
  }
  const cellBytes = cells * 4;
  const sharedScratchBytes = cellBytes;
  const materialTableBytes = align16(input.materialCount * MATERIAL_BYTES);
  const ruleTableBytes = align16(input.ruleCount * RULE_BYTES);
  const wasmEventBytes = input.eventCapacity * EVENT_RECORD_BYTES;
  const sharedEventBytes = EVENT_HEADER_BYTES + wasmEventBytes;
  const mainEventDrainBytes = wasmEventBytes;
  const chunks = Math.ceil(input.width / CHUNK_SIZE) * Math.ceil(input.height / CHUNK_SIZE);
  const activeChunkBytes = chunks * 3;
  const presentationBytes = cellBytes;
  const wasmBytes = cellBytes + sharedScratchBytes + materialTableBytes + ruleTableBytes +
    fieldBytes + wasmEventBytes;
  const wasmRoundedBytes = Math.ceil(wasmBytes / WASM_PAGE_BYTES) * WASM_PAGE_BYTES;
  return {
    cellBytes,
    sharedScratchBytes,
    materialTableBytes,
    ruleTableBytes,
    fieldBytes,
    wasmEventBytes,
    sharedEventBytes,
    mainEventDrainBytes,
    activeChunkBytes,
    presentationBytes,
    wasmBytes,
    wasmRoundedBytes,
    totalOwnedBytes: wasmRoundedBytes + sharedEventBytes + mainEventDrainBytes +
      activeChunkBytes + presentationBytes,
  };
}

/** Sizes an SPSC event ring for a peak semantic-event rate and bounded consumer lag. */
export function recommendPixelEventCapacity(
  peakEventsPerTick: number,
  consumerLagTicks: number,
  headroom: number,
): number {
  nonNegativeInteger(peakEventsPerTick, "peakEventsPerTick");
  positiveInteger(consumerLagTicks, "consumerLagTicks");
  if (!Number.isFinite(headroom) || headroom < 1) {
    throw new RangeError("headroom must be at least 1");
  }
  const required = Math.max(2, Math.ceil(peakEventsPerTick * consumerLagTicks * headroom));
  if (required > 1_048_576) throw new RangeError("recommended event capacity exceeds the ABI");
  return 2 ** Math.ceil(Math.log2(required));
}

function align16(value: number): number {
  return (value + 15) & ~15;
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
}

function positiveInteger(value: number, name: string): void {
  boundedInteger(value, 1, Number.MAX_SAFE_INTEGER, name);
}

function nonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}
