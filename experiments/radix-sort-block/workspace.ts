const WASM_PAGE_BYTES = 65_536;
const HISTOGRAM_BYTES = 256 * 4;

interface RadixSortKernels extends WebAssembly.Exports {
  sort_u32(values: number, scratch: number, length: number, histogram: number): void;
  sort_u32_pairs(
    keys: number,
    payloads: number,
    scratchKeys: number,
    scratchPayloads: number,
    length: number,
    histogram: number,
  ): void;
  sort_u64(values: number, scratch: number, length: number, histogram: number): void;
}

interface Layout {
  readonly scratchOffset: number;
  readonly payloadOffset: number;
  readonly scratchKeysOffset: number;
  readonly scratchPayloadsOffset: number;
  readonly histogramOffset: number;
  readonly byteLength: number;
}

let modulePromise: Promise<WebAssembly.Module> | undefined;
const NATIVE_PACKED_THRESHOLD = 32_768;
const SAMPLE_VALUES = 4_096;
const HOST_IS_LITTLE_ENDIAN = new Uint8Array(Uint32Array.of(1).buffer)[0] === 1;

export type RadixOrderStrategy = "already-sorted" | "native-packed" | "wasm-radix";

/** Structural subset of columnar U32OrderMetadata consumed by the physical planner. */
export interface U32OrderFacts {
  readonly rowCount: number;
  readonly ascending: boolean | undefined;
  readonly adjacentInversions: number | undefined;
  readonly valueRange: number | null;
}

/** Reusable copy-inclusive admission workspace for unsigned LSD radix sorting. */
export class RadixSortBlockWorkspace implements AsyncDisposable, Disposable {
  readonly capacity: number;
  readonly byteLength: number;
  readonly #memory: WebAssembly.Memory;
  readonly #kernels: RadixSortKernels;
  readonly #layout: Layout;
  #packedOrder: BigUint64Array | null = null;
  #disposed = false;

  private constructor(
    capacity: number,
    memory: WebAssembly.Memory,
    kernels: RadixSortKernels,
    layout: Layout,
  ) {
    this.capacity = capacity;
    this.byteLength = layout.byteLength;
    this.#memory = memory;
    this.#kernels = kernels;
    this.#layout = layout;
  }

  static async create(capacity: number): Promise<RadixSortBlockWorkspace> {
    validateCapacity(capacity);
    const layout = createLayout(capacity);
    const pages = Math.max(1, Math.ceil(layout.byteLength / WASM_PAGE_BYTES));
    const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
    const module = await compileModule();
    const instance = new WebAssembly.Instance(module, { jsimd: { memory } });
    return new RadixSortBlockWorkspace(
      capacity,
      memory,
      instance.exports as RadixSortKernels,
      layout,
    );
  }

  sortU32Into(input: Uint32Array, output: Uint32Array): Uint32Array {
    if (!(output instanceof Uint32Array) || output.length < input.length) {
      throw new RangeError("output must cover every input value");
    }
    this.loadAndSortU32(input);
    output.set(new Uint32Array(this.#memory.buffer, 0, input.length));
    return output;
  }

  sortU64Into(input: BigUint64Array, output: BigUint64Array): BigUint64Array {
    if (!(output instanceof BigUint64Array) || output.length < input.length) {
      throw new RangeError("output must cover every input value");
    }
    this.loadAndSortU64(input);
    output.set(new BigUint64Array(this.#memory.buffer, 0, input.length));
    return output;
  }

  /** Stably sorts unsigned keys while applying the same permutation to u32 payloads. */
  sortU32PairsInto(
    keys: Uint32Array,
    payloads: Uint32Array,
    outputKeys: Uint32Array,
    outputPayloads: Uint32Array,
  ): void {
    this.#assertAlive();
    if (payloads.length !== keys.length) {
      throw new RangeError("keys and payloads must have equal lengths");
    }
    if (outputKeys.length < keys.length || outputPayloads.length < keys.length) {
      throw new RangeError("outputs must cover every key and payload");
    }
    this.#assertLength(keys.length);
    new Uint32Array(this.#memory.buffer, 0, keys.length).set(keys);
    new Uint32Array(this.#memory.buffer, this.#layout.payloadOffset, payloads.length).set(payloads);
    this.#kernels.sort_u32_pairs(
      0,
      this.#layout.payloadOffset,
      this.#layout.scratchKeysOffset,
      this.#layout.scratchPayloadsOffset,
      keys.length,
      this.#layout.histogramOffset,
    );
    outputKeys.set(new Uint32Array(this.#memory.buffer, 0, keys.length));
    outputPayloads.set(
      new Uint32Array(this.#memory.buffer, this.#layout.payloadOffset, payloads.length),
    );
  }

  /** Produces stable sorted keys and row IDs with a distribution-aware physical path. */
  orderU32Into(
    keys: Uint32Array,
    outputKeys: Uint32Array,
    outputRowIds: Uint32Array,
    facts?: U32OrderFacts,
  ): RadixOrderStrategy {
    this.#assertAlive();
    if (!(keys instanceof Uint32Array)) throw new TypeError("keys must be a Uint32Array");
    if (outputKeys.length < keys.length || outputRowIds.length < keys.length) {
      throw new RangeError("outputs must cover every key and row ID");
    }
    this.#assertLength(keys.length);
    const strategy = facts === undefined
      ? chooseOrderStrategy(keys, outputKeys, outputRowIds)
      : chooseOrderStrategyFromFacts(keys.length, facts);
    if (strategy === "already-sorted") {
      if (facts !== undefined) copyIdentityOrder(keys, outputKeys, outputRowIds);
      return strategy;
    }
    if (strategy === "native-packed") {
      this.#sortPackedU32Into(keys, outputKeys, outputRowIds);
      return strategy;
    }
    const rowIds = new Uint32Array(this.#memory.buffer, this.#layout.payloadOffset, keys.length);
    for (let index = 0; index < keys.length; index++) rowIds[index] = index;
    new Uint32Array(this.#memory.buffer, 0, keys.length).set(keys);
    this.#kernels.sort_u32_pairs(
      0,
      this.#layout.payloadOffset,
      this.#layout.scratchKeysOffset,
      this.#layout.scratchPayloadsOffset,
      keys.length,
      this.#layout.histogramOffset,
    );
    outputKeys.set(new Uint32Array(this.#memory.buffer, 0, keys.length));
    outputRowIds.set(rowIds);
    return strategy;
  }

  /** Copies unsorted input into the resident workspace and runs four radix passes. */
  loadAndSortU32(input: Uint32Array): this {
    this.#assertAlive();
    if (!(input instanceof Uint32Array)) throw new TypeError("input must be a Uint32Array");
    this.#assertLength(input.length);
    new Uint32Array(this.#memory.buffer, 0, input.length).set(input);
    this.#kernels.sort_u32(
      0,
      this.#layout.scratchOffset,
      input.length,
      this.#layout.histogramOffset,
    );
    return this;
  }

  /** Copies unsorted input into the resident workspace and runs eight radix passes. */
  loadAndSortU64(input: BigUint64Array): this {
    this.#assertAlive();
    if (!(input instanceof BigUint64Array)) throw new TypeError("input must be a BigUint64Array");
    this.#assertLength(input.length);
    new BigUint64Array(this.#memory.buffer, 0, input.length).set(input);
    this.#kernels.sort_u64(
      0,
      this.#layout.scratchOffset,
      input.length,
      this.#layout.histogramOffset,
    );
    return this;
  }

  [Symbol.dispose](): void {
    this.#disposed = true;
    this.#packedOrder = null;
  }

  [Symbol.asyncDispose](): Promise<void> {
    this[Symbol.dispose]();
    return Promise.resolve();
  }

  #assertLength(length: number): void {
    if (length > this.capacity) throw new RangeError("input exceeds workspace capacity");
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("RadixSortBlockWorkspace has been disposed");
  }

  #sortPackedU32Into(
    keys: Uint32Array,
    outputKeys: Uint32Array,
    outputRowIds: Uint32Array,
  ): void {
    const packed = this.#packedOrder ??= new BigUint64Array(this.capacity);
    if (HOST_IS_LITTLE_ENDIAN) {
      const words = new Uint32Array(packed.buffer);
      for (let index = 0; index < keys.length; index++) {
        words[index * 2] = index;
        words[index * 2 + 1] = keys[index]!;
      }
      packed.subarray(0, keys.length).sort();
      for (let index = 0; index < keys.length; index++) {
        outputRowIds[index] = words[index * 2]!;
        outputKeys[index] = words[index * 2 + 1]!;
      }
      return;
    }
    for (let index = 0; index < keys.length; index++) {
      packed[index] = BigInt(keys[index]!) << 32n | BigInt(index);
    }
    packed.subarray(0, keys.length).sort();
    for (let index = 0; index < keys.length; index++) {
      outputRowIds[index] = Number(packed[index]! & 0xffff_ffffn);
      outputKeys[index] = Number(packed[index]! >> 32n);
    }
  }
}

function chooseOrderStrategyFromFacts(
  length: number,
  facts: U32OrderFacts,
): RadixOrderStrategy {
  if (!Number.isSafeInteger(facts.rowCount) || facts.rowCount !== length) {
    throw new RangeError("order metadata rowCount must match the key column");
  }
  if (facts.ascending !== undefined && typeof facts.ascending !== "boolean") {
    throw new TypeError("order metadata ascending must be boolean or undefined");
  }
  if (
    facts.adjacentInversions !== undefined &&
    (!Number.isSafeInteger(facts.adjacentInversions) || facts.adjacentInversions < 0 ||
      facts.adjacentInversions > Math.max(0, length - 1))
  ) throw new RangeError("order metadata adjacentInversions is invalid");
  if (
    facts.valueRange !== null &&
    (!Number.isSafeInteger(facts.valueRange) || facts.valueRange < 1 ||
      facts.valueRange > 0x1_0000_0000)
  ) throw new RangeError("order metadata valueRange is invalid");
  if (facts.ascending === true || facts.adjacentInversions === 0) return "already-sorted";
  if (
    length < NATIVE_PACKED_THRESHOLD ||
    (facts.adjacentInversions !== undefined && facts.adjacentInversions <= length >>> 6) ||
    (facts.valueRange !== null && facts.valueRange <= SAMPLE_VALUES >>> 2)
  ) return "native-packed";
  if (facts.adjacentInversions !== undefined) return "wasm-radix";
  throw new RangeError("order metadata lacks adjacent inversion facts");
}

function copyIdentityOrder(
  keys: Uint32Array,
  outputKeys: Uint32Array,
  outputRowIds: Uint32Array,
): void {
  outputKeys.set(keys);
  for (let index = 0; index < keys.length; index++) outputRowIds[index] = index;
}

function chooseOrderStrategy(
  keys: Uint32Array,
  candidateKeys: Uint32Array,
  candidateRowIds: Uint32Array,
): RadixOrderStrategy {
  candidateKeys.set(keys);
  let inversions = 0;
  for (let index = 0; index < keys.length; index++) {
    candidateRowIds[index] = index;
    if (index === 0) continue;
    if (keys[index - 1]! > keys[index]!) inversions++;
  }
  if (inversions === 0) return "already-sorted";
  if (keys.length < NATIVE_PACKED_THRESHOLD || inversions <= keys.length >>> 6) {
    return "native-packed";
  }
  const sampleLength = Math.min(keys.length, SAMPLE_VALUES);
  const distinct = new Set<number>();
  for (let sample = 0; sample < sampleLength; sample++) {
    distinct.add(keys[Math.floor(sample * keys.length / sampleLength)]!);
  }
  return distinct.size <= Math.max(64, sampleLength >>> 2) ? "native-packed" : "wasm-radix";
}

function createLayout(capacity: number): Layout {
  const scratchOffset = alignTo(capacity * 8, 16);
  const payloadOffset = alignTo(capacity * 4, 16);
  const scratchKeysOffset = alignTo(payloadOffset + capacity * 4, 16);
  const scratchPayloadsOffset = alignTo(scratchKeysOffset + capacity * 4, 16);
  const pairEnd = scratchPayloadsOffset + capacity * 4;
  const u64End = scratchOffset + capacity * 8;
  const histogramOffset = alignTo(Math.max(pairEnd, u64End), 16);
  const byteLength = histogramOffset + HISTOGRAM_BYTES;
  if (!Number.isSafeInteger(byteLength) || byteLength > WASM_PAGE_BYTES * 65_536) {
    throw new RangeError("radix workspace exceeds the Wasm memory limit");
  }
  return {
    scratchOffset,
    payloadOffset,
    scratchKeysOffset,
    scratchPayloadsOffset,
    histogramOffset,
    byteLength,
  };
}

function validateCapacity(capacity: number): void {
  if (!Number.isSafeInteger(capacity) || capacity < 0 || capacity > 0x0fff_ffff) {
    throw new RangeError("capacity must be a non-negative Wasm-addressable integer");
  }
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function compileModule(): Promise<WebAssembly.Module> {
  return modulePromise ??= loadModule(new URL("./kernels.wasm", import.meta.url));
}

async function loadModule(url: URL): Promise<WebAssembly.Module> {
  if (url.protocol === "file:") {
    return await WebAssembly.compile(await Deno.readFile(url) as BufferSource);
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to load radix sort Wasm: ${response.status}`);
  return await WebAssembly.compile(await response.arrayBuffer());
}
