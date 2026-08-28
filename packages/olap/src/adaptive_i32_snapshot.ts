import { decodeAdaptiveI32Snapshot, invalidSnapshot, uint32Payload } from "./snapshot_codec.ts";

const ADAPTIVE_PAGE_ROWS = 256;
const PAGE_METADATA_WORDS = 6;

/** Stable descriptor values consumed by the shared query Worker ABI. */
export const SharedI32PageEncoding = Object.freeze(
  {
    Raw: 0,
    Constant: 1,
    FrameOfReference: 2,
  } as const,
);

export type SharedI32PageEncoding =
  typeof SharedI32PageEncoding[keyof typeof SharedI32PageEncoding];

export interface ParsedAdaptiveI32Page {
  readonly rowOffset: number;
  readonly length: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly encoding: SharedI32PageEncoding;
  readonly bitWidth: number;
  /** A view into the immutable serialized snapshot; no decoded value array is created. */
  readonly payload: Uint8Array;
}

export interface ParsedAdaptiveI32Snapshot {
  readonly length: number;
  readonly payloadBytes: number;
  readonly pages: readonly ParsedAdaptiveI32Page[];
}

/** Parses and validates the persisted AdaptiveI32Column format without allocating a resident column. */
export function parseAdaptiveI32Snapshot(snapshot: Uint8Array): ParsedAdaptiveI32Snapshot {
  const decoded = decodeAdaptiveI32Snapshot(snapshot);
  const length = decoded.shape[0]!;
  const pageCount = decoded.shape[1]!;
  if (length > 0x3fff_ffff || pageCount !== Math.ceil(length / ADAPTIVE_PAGE_ROWS)) {
    throw invalidSnapshot("invalid adaptive column shape");
  }
  const metadataBytes = decoded.payloads[0]!;
  const storage = decoded.payloads[1]!;
  if (metadataBytes.byteLength !== pageCount * PAGE_METADATA_WORDS * 4) {
    throw invalidSnapshot("invalid adaptive page metadata byte length");
  }
  const metadata = uint32Payload(metadataBytes, "adaptive page metadata");
  const pages: ParsedAdaptiveI32Page[] = [];
  let expectedPayloadOffset = 0;
  for (let index = 0; index < pageCount; index++) {
    const base = index * PAGE_METADATA_WORDS;
    const header = metadata[base]!;
    const pageLength = header & 0xffff;
    const sourceEncoding = (header >>> 16) & 0xff;
    const bitWidth = header >>> 24;
    const minimum = metadata[base + 1]! | 0;
    const maximum = metadata[base + 2]! | 0;
    const packedWords = metadata[base + 3]!;
    const payloadOffset = metadata[base + 4]!;
    const payloadBytes = metadata[base + 5]!;
    const expectedLength = Math.min(ADAPTIVE_PAGE_ROWS, length - index * ADAPTIVE_PAGE_ROWS);
    if (pageLength !== expectedLength) throw invalidSnapshot("invalid adaptive page length");
    if (
      payloadOffset !== expectedPayloadOffset ||
      payloadBytes > storage.byteLength - payloadOffset
    ) throw invalidSnapshot("invalid adaptive page payload range");
    const payload = storage.subarray(payloadOffset, payloadOffset + payloadBytes);
    const encoding = validatePage(
      pageLength,
      minimum,
      maximum,
      sourceEncoding,
      bitWidth,
      packedWords,
      payload,
    );
    pages.push(Object.freeze({
      rowOffset: index * ADAPTIVE_PAGE_ROWS,
      length: pageLength,
      minimum,
      maximum,
      encoding,
      bitWidth,
      payload,
    }));
    expectedPayloadOffset += payloadBytes;
  }
  if (expectedPayloadOffset !== storage.byteLength) {
    throw invalidSnapshot("adaptive payload has trailing bytes");
  }
  return Object.freeze({
    length,
    payloadBytes: storage.byteLength,
    pages: Object.freeze(pages),
  });
}

function validatePage(
  length: number,
  minimum: number,
  maximum: number,
  sourceEncoding: number,
  bitWidth: number,
  packedWords: number,
  payload: Uint8Array,
): SharedI32PageEncoding {
  if (minimum > maximum) throw invalidSnapshot("inverted adaptive ZoneMap");
  if (sourceEncoding === 0) {
    if (minimum !== maximum || bitWidth !== 0 || packedWords !== 0 || payload.byteLength !== 0) {
      throw invalidSnapshot("invalid constant adaptive page");
    }
    return SharedI32PageEncoding.Constant;
  }
  if (sourceEncoding === 1) {
    const range = maximum - minimum;
    const expectedWidth = range === 0 ? 0 : 32 - Math.clz32(range);
    const expectedWords = Math.ceil(length * bitWidth / 32);
    if (
      bitWidth < 1 || bitWidth > 16 || bitWidth !== expectedWidth ||
      packedWords !== expectedWords || payload.byteLength !== expectedWords * 4
    ) throw invalidSnapshot("invalid FOR adaptive page");
    const words = uint32Payload(payload, "adaptive FOR payload");
    let observedMinimum = Number.POSITIVE_INFINITY;
    let observedMaximum = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < length; index++) {
      const value = minimum + packedAt(words, bitWidth, index);
      if (value < observedMinimum) observedMinimum = value;
      if (value > observedMaximum) observedMaximum = value;
    }
    const usedBits = length * bitWidth;
    if ((usedBits & 31) !== 0 && (words[words.length - 1]! >>> (usedBits & 31)) !== 0) {
      throw invalidSnapshot("non-zero FOR padding");
    }
    if (observedMinimum !== minimum || observedMaximum !== maximum) {
      throw invalidSnapshot("FOR payload does not match ZoneMap");
    }
    return SharedI32PageEncoding.FrameOfReference;
  }
  if (sourceEncoding === 2) {
    if (bitWidth !== 32 || packedWords !== 0 || payload.byteLength !== length * 4) {
      throw invalidSnapshot("invalid raw adaptive page");
    }
    const words = uint32Payload(payload, "adaptive raw payload");
    let observedMinimum = words[0]! | 0;
    let observedMaximum = observedMinimum;
    for (let index = 1; index < words.length; index++) {
      const value = words[index]! | 0;
      if (value < observedMinimum) observedMinimum = value;
      if (value > observedMaximum) observedMaximum = value;
    }
    if (observedMinimum !== minimum || observedMaximum !== maximum) {
      throw invalidSnapshot("raw payload does not match ZoneMap");
    }
    return SharedI32PageEncoding.Raw;
  }
  throw invalidSnapshot("unknown adaptive page encoding");
}

function packedAt(words: Uint32Array, bitWidth: number, index: number): number {
  const bit = index * bitWidth;
  const word = bit >>> 5;
  const shift = bit & 31;
  let value = words[word]! >>> shift;
  if (shift + bitWidth > 32) value |= words[word + 1]! << (32 - shift);
  return value & (0xffff_ffff >>> (32 - bitWidth));
}
