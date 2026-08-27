const NULLABLE_MAGIC = 0x4e50_534a;
const STRING_MAGIC = 0x5350_534a;
const VERSION = 1;
const NULLABLE_HEADER_BYTES = 20;
const STRING_HEADER_BYTES = 36;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface NullableStoredPage {
  readonly inner: Uint8Array;
  readonly validity: Uint8Array;
}

export interface DictionaryStringPage {
  readonly length: number;
  readonly dictionary: readonly string[];
  readonly codes: Uint32Array;
  readonly validity: Uint8Array | undefined;
}

export function encodeNullableStoredPage(
  inner: Uint8Array,
  validity: Uint8Array,
): Uint8Array {
  const normalized = normalizeValidity(validity);
  const output = new Uint8Array(
    NULLABLE_HEADER_BYTES + inner.byteLength + normalized.byteLength,
  );
  const view = new DataView(output.buffer);
  view.setUint32(0, NULLABLE_MAGIC, true);
  view.setUint16(4, VERSION, true);
  view.setUint32(8, inner.byteLength, true);
  view.setUint32(12, normalized.byteLength, true);
  output.set(inner, NULLABLE_HEADER_BYTES);
  output.set(normalized, NULLABLE_HEADER_BYTES + inner.byteLength);
  view.setUint32(16, checksum(output.subarray(NULLABLE_HEADER_BYTES)), true);
  return output;
}

export function decodeNullableStoredPage(bytes: Uint8Array): NullableStoredPage {
  const view = checkedView(bytes, NULLABLE_HEADER_BYTES, NULLABLE_MAGIC);
  const innerBytes = view.getUint32(8, true);
  const validityBytes = view.getUint32(12, true);
  if (bytes.byteLength !== NULLABLE_HEADER_BYTES + innerBytes + validityBytes) {
    throw new RangeError("nullable page payload length mismatch");
  }
  const payload = bytes.subarray(NULLABLE_HEADER_BYTES);
  if (view.getUint32(16, true) !== checksum(payload)) {
    throw new RangeError("nullable page checksum mismatch");
  }
  return Object.freeze({
    inner: payload.slice(0, innerBytes),
    validity: payload.slice(innerBytes),
  });
}

export function encodeDictionaryStringPage(
  values: readonly (string | null)[],
  nullable: boolean,
): Uint8Array {
  const unique = new Set<string>();
  for (const value of values) {
    if (value === null) {
      if (!nullable) throw new TypeError("non-nullable string column contains null");
    } else {
      if (typeof value !== "string") throw new TypeError("string column contains a non-string");
      unique.add(value);
    }
  }
  const dictionary = Array.from(unique).sort();
  const codeByValue = new Map(dictionary.map((value, index) => [value, index]));
  const codes = new Uint32Array(values.length);
  const validity = nullable ? new Uint8Array(values.length) : undefined;
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    if (value === null) continue;
    codes[index] = codeByValue.get(value)!;
    if (validity !== undefined) validity[index] = 1;
  }
  const encoded = dictionary.map((value) => encoder.encode(value));
  const offsets = new Uint32Array(dictionary.length + 1);
  let textBytes = 0;
  for (let index = 0; index < encoded.length; index++) {
    textBytes += encoded[index]!.byteLength;
    offsets[index + 1] = textBytes;
  }
  const validityBytes = validity?.byteLength ?? 0;
  const codesBytes = codes.byteLength;
  const offsetsBytes = offsets.byteLength;
  const output = new Uint8Array(
    STRING_HEADER_BYTES + validityBytes + codesBytes + offsetsBytes + textBytes,
  );
  const view = new DataView(output.buffer);
  view.setUint32(0, STRING_MAGIC, true);
  view.setUint16(4, VERSION, true);
  view.setUint16(6, nullable ? 1 : 0, true);
  view.setUint32(8, values.length, true);
  view.setUint32(12, dictionary.length, true);
  view.setUint32(16, validityBytes, true);
  view.setUint32(20, codesBytes, true);
  view.setUint32(24, offsetsBytes, true);
  view.setUint32(28, textBytes, true);
  let offset = STRING_HEADER_BYTES;
  if (validity !== undefined) {
    output.set(validity, offset);
    offset += validityBytes;
  }
  for (const code of codes) {
    view.setUint32(offset, code, true);
    offset += 4;
  }
  for (const item of offsets) {
    view.setUint32(offset, item, true);
    offset += 4;
  }
  for (const item of encoded) {
    output.set(item, offset);
    offset += item.byteLength;
  }
  view.setUint32(32, checksum(output.subarray(STRING_HEADER_BYTES)), true);
  return output;
}

export function decodeDictionaryStringPage(
  bytes: Uint8Array,
  expectedNullable: boolean,
): DictionaryStringPage {
  const view = checkedView(bytes, STRING_HEADER_BYTES, STRING_MAGIC);
  const nullable = (view.getUint16(6, true) & 1) !== 0;
  if (nullable !== expectedNullable) throw new RangeError("string page nullability mismatch");
  const length = view.getUint32(8, true);
  const dictionaryCount = view.getUint32(12, true);
  const validityBytes = view.getUint32(16, true);
  const codesBytes = view.getUint32(20, true);
  const offsetsBytes = view.getUint32(24, true);
  const textBytes = view.getUint32(28, true);
  if (
    validityBytes !== (nullable ? length : 0) || codesBytes !== length * 4 ||
    offsetsBytes !== (dictionaryCount + 1) * 4 ||
    bytes.byteLength !==
      STRING_HEADER_BYTES + validityBytes + codesBytes + offsetsBytes + textBytes
  ) {
    throw new RangeError("string page payload length mismatch");
  }
  if (view.getUint32(32, true) !== checksum(bytes.subarray(STRING_HEADER_BYTES))) {
    throw new RangeError("string page checksum mismatch");
  }
  let offset = STRING_HEADER_BYTES;
  const validity = nullable ? bytes.slice(offset, offset + validityBytes) : undefined;
  offset += validityBytes;
  if (validity !== undefined) validateValidity(validity);
  const codes = new Uint32Array(length);
  for (let index = 0; index < length; index++, offset += 4) {
    codes[index] = view.getUint32(offset, true);
  }
  const offsets = new Uint32Array(dictionaryCount + 1);
  for (let index = 0; index < offsets.length; index++, offset += 4) {
    offsets[index] = view.getUint32(offset, true);
  }
  if (offsets[0] !== 0 || offsets[dictionaryCount] !== textBytes) {
    throw new RangeError("invalid string dictionary offsets");
  }
  const text = bytes.subarray(offset);
  const dictionary: string[] = [];
  for (let index = 0; index < dictionaryCount; index++) {
    const start = offsets[index]!;
    const end = offsets[index + 1]!;
    if (start > end || end > textBytes) throw new RangeError("invalid string dictionary offsets");
    dictionary.push(decoder.decode(text.subarray(start, end)));
  }
  for (let index = 0; index < codes.length; index++) {
    if ((validity === undefined || validity[index] !== 0) && codes[index]! >= dictionary.length) {
      throw new RangeError("string page dictionary code out of bounds");
    }
  }
  return Object.freeze({ length, dictionary: Object.freeze(dictionary), codes, validity });
}

export function stringPageHostBytes(page: DictionaryStringPage): number {
  let bytes = page.codes.byteLength + (page.validity?.byteLength ?? 0);
  for (const value of page.dictionary) bytes += value.length * 2 + 8;
  return bytes + (page.dictionary.length + 1) * 4;
}

function checkedView(bytes: Uint8Array, headerBytes: number, magic: number): DataView {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < headerBytes) {
    throw new RangeError("stored page is truncated");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== magic) throw new RangeError("invalid stored page magic");
  if (view.getUint16(4, true) !== VERSION) throw new RangeError("unsupported stored page version");
  return view;
}

function normalizeValidity(validity: Uint8Array): Uint8Array {
  const output = new Uint8Array(validity.length);
  for (let index = 0; index < validity.length; index++) {
    output[index] = validity[index] === 0 ? 0 : 1;
  }
  return output;
}

function validateValidity(validity: Uint8Array): void {
  for (const value of validity) {
    if (value > 1) throw new RangeError("validity bytes must be zero or one");
  }
}

function checksum(bytes: Uint8Array): number {
  let hash = 0x811c_9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x0100_0193) >>> 0;
  return hash;
}
