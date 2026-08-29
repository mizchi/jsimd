export const I32 = 0x7f;
export const F32 = 0x7d;
export const V128 = 0x7b;
export const EMPTY_BLOCK = 0x40;

export function emitImportedMemoryModule(
  parameterTypes: readonly number[],
  body: ByteWriter,
): Uint8Array<ArrayBuffer> {
  const functionType = new ByteWriter().byte(0x60).vector(parameterTypes).vector([]);
  const memoryImport = new ByteWriter()
    .name("env")
    .name("memory")
    .byte(0x02)
    .byte(0x00)
    .unsigned(1);
  const functionExport = new ByteWriter().name("run").byte(0x00).unsigned(0);
  const code = new ByteWriter().sized(body);

  return new ByteWriter()
    .bytes([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
    .section(1, new ByteWriter().vector([functionType]))
    .section(2, new ByteWriter().vector([memoryImport]))
    .section(3, new ByteWriter().vector([[0]]))
    .section(7, new ByteWriter().vector([functionExport]))
    .section(10, new ByteWriter().vector([code]))
    .finish();
}

export class ByteWriter {
  readonly #bytes: number[] = [];

  byte(value: number): this {
    this.#bytes.push(value & 0xff);
    return this;
  }

  bytes(values: ArrayLike<number>): this {
    for (let index = 0; index < values.length; index++) this.byte(values[index]!);
    return this;
  }

  instruction(value: number): this {
    return this.byte(value);
  }

  prefixed(prefix: number, value: number): this {
    this.byte(prefix);
    return this.unsigned(value);
  }

  simd(value: number): this {
    return this.prefixed(0xfd, value);
  }

  unsigned(value: number): this {
    let remaining = value >>> 0;
    do {
      let next = remaining & 0x7f;
      remaining >>>= 7;
      if (remaining !== 0) next |= 0x80;
      this.byte(next);
    } while (remaining !== 0);
    return this;
  }

  signed(value: number): this {
    let remaining = value | 0;
    let more = true;
    while (more) {
      let next = remaining & 0x7f;
      remaining >>= 7;
      const signSet = (next & 0x40) !== 0;
      more = !((remaining === 0 && !signSet) || (remaining === -1 && signSet));
      if (more) next |= 0x80;
      this.byte(next);
    }
    return this;
  }

  float32(value: number): this {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setFloat32(0, value, true);
    return this.bytes(bytes);
  }

  memoryArgument(alignmentExponent: number, offset = 0): this {
    return this.unsigned(alignmentExponent).unsigned(offset);
  }

  name(value: string): this {
    const bytes = new TextEncoder().encode(value);
    return this.unsigned(bytes.length).bytes(bytes);
  }

  vector(values: readonly (number | readonly number[] | ByteWriter)[]): this {
    this.unsigned(values.length);
    for (const value of values) {
      if (typeof value === "number") this.byte(value);
      else if (value instanceof ByteWriter) this.bytes(value.#bytes);
      else this.bytes(value);
    }
    return this;
  }

  sized(value: ByteWriter): this {
    return this.unsigned(value.#bytes.length).bytes(value.#bytes);
  }

  section(id: number, payload: ByteWriter): this {
    return this.byte(id).sized(payload);
  }

  finish(): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(this.#bytes);
  }
}
