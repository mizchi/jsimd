export interface MonotoneUint32Source {
  readonly length: number;
  valuesInto(output: Uint32Array): number;
}

/** Host-side mutable source that can be frozen into an explicitly chosen ordered encoding. */
export class MonotoneUint32Builder implements MonotoneUint32Source {
  readonly #values: number[] = [];

  get length(): number {
    return this.#values.length;
  }

  append(value: number): this {
    const normalized = validateUint32(value);
    const previous = this.#values[this.#values.length - 1];
    if (previous !== undefined && normalized < previous) {
      throw new RangeError("values must be non-decreasing");
    }
    this.#values.push(normalized);
    return this;
  }

  valuesInto(output: Uint32Array): number {
    if (!(output instanceof Uint32Array)) throw new TypeError("output must be a Uint32Array");
    if (output.length < this.#values.length) {
      throw new RangeError("output is too small for monotone values");
    }
    output.set(this.#values, 0);
    return this.#values.length;
  }
}

export function copyMonotoneSource(source: MonotoneUint32Source): Uint32Array {
  if (source === null || typeof source !== "object") {
    throw new TypeError("source must be a monotone Uint32 source");
  }
  const { length } = source;
  if (!Number.isSafeInteger(length) || length < 0 || length > 0x3fff_ffff) {
    throw new RangeError("invalid monotone source length");
  }
  if (typeof source.valuesInto !== "function") {
    throw new TypeError("source must provide valuesInto(output)");
  }
  const output = new Uint32Array(length);
  const written = source.valuesInto(output);
  if (written !== length) throw new RangeError("monotone source wrote an unexpected value count");
  return output;
}

function validateUint32(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError("value must be an unsigned 32-bit integer");
  }
  return value;
}
