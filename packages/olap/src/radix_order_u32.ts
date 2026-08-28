import type { U32OrderMetadata } from "@mizchi/jsimd-columnar";

const WASM_PAGE_BYTES = 65_536;
const HISTOGRAM_BYTES = 256 * 4;
const NATIVE_PACKED_THRESHOLD = 32_768;
const NARROW_VALUE_RANGE = 1_024;
const HOST_IS_LITTLE_ENDIAN = new Uint8Array(Uint32Array.of(1).buffer)[0] === 1;

export type RadixOrderStrategy = "already-sorted" | "native-packed" | "wasm-radix";
export type U32OrderFacts = Pick<
  U32OrderMetadata,
  "rowCount" | "ascending" | "adjacentInversions" | "valueRange"
>;

interface RadixOrderKernels extends WebAssembly.Exports {
  sort_u32_pairs(
    keys: number,
    payloads: number,
    scratchKeys: number,
    scratchPayloads: number,
    length: number,
    histogram: number,
  ): void;
}

interface Layout {
  readonly payloadOffset: number;
  readonly scratchKeysOffset: number;
  readonly scratchPayloadsOffset: number;
  readonly histogramOffset: number;
  readonly byteLength: number;
}

let modulePromise: Promise<WebAssembly.Module> | undefined;

/** Stable physical ORDER BY for non-nullable u32 keys and caller-owned row-ID output. */
export class RadixOrderU32 implements AsyncDisposable, Disposable {
  readonly capacity: number;
  readonly byteLength: number;
  readonly #memory: WebAssembly.Memory;
  readonly #kernels: RadixOrderKernels;
  readonly #layout: Layout;
  #packedOrder: BigUint64Array | null = null;
  #disposed = false;

  private constructor(
    capacity: number,
    memory: WebAssembly.Memory,
    kernels: RadixOrderKernels,
    layout: Layout,
  ) {
    this.capacity = capacity;
    this.byteLength = layout.byteLength;
    this.#memory = memory;
    this.#kernels = kernels;
    this.#layout = layout;
  }

  static async create(capacity: number): Promise<RadixOrderU32> {
    validateCapacity(capacity);
    const layout = createLayout(capacity);
    const pages = Math.max(1, Math.ceil(layout.byteLength / WASM_PAGE_BYTES));
    const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
    const module = await compileModule();
    const instance = new WebAssembly.Instance(module, { jsimd: { memory } });
    return new RadixOrderU32(
      capacity,
      memory,
      instance.exports as RadixOrderKernels,
      layout,
    );
  }

  orderInto(
    keys: Uint32Array,
    outputKeys: Uint32Array,
    outputRowIds: Uint32Array,
    facts: U32OrderFacts,
  ): RadixOrderStrategy {
    this.#assertAlive();
    if (!(keys instanceof Uint32Array)) throw new TypeError("keys must be a Uint32Array");
    if (!(outputKeys instanceof Uint32Array) || !(outputRowIds instanceof Uint32Array)) {
      throw new TypeError("outputs must be Uint32Array instances");
    }
    if (keys.length > this.capacity) throw new RangeError("keys exceed order capacity");
    if (outputKeys.length < keys.length || outputRowIds.length < keys.length) {
      throw new RangeError("outputs must cover every key and row ID");
    }
    const strategy = chooseStrategy(keys.length, facts);
    if (strategy === "already-sorted") {
      copyIdentity(keys, outputKeys, outputRowIds);
    } else if (strategy === "native-packed") {
      this.#sortPackedInto(keys, outputKeys, outputRowIds);
    } else {
      this.#sortRadixInto(keys, outputKeys, outputRowIds);
    }
    return strategy;
  }

  [Symbol.dispose](): void {
    this.#disposed = true;
    this.#packedOrder = null;
  }

  [Symbol.asyncDispose](): Promise<void> {
    this[Symbol.dispose]();
    return Promise.resolve();
  }

  #sortRadixInto(
    keys: Uint32Array,
    outputKeys: Uint32Array,
    outputRowIds: Uint32Array,
  ): void {
    new Uint32Array(this.#memory.buffer, 0, keys.length).set(keys);
    const rowIds = new Uint32Array(this.#memory.buffer, this.#layout.payloadOffset, keys.length);
    for (let index = 0; index < keys.length; index++) rowIds[index] = index;
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
  }

  #sortPackedInto(
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

  #assertAlive(): void {
    if (this.#disposed) throw new Error("RadixOrderU32 has been disposed");
  }
}

function chooseStrategy(length: number, facts: U32OrderFacts): RadixOrderStrategy {
  if (!Number.isSafeInteger(facts.rowCount) || facts.rowCount !== length) {
    throw new RangeError("order metadata rowCount must match keys");
  }
  const inversions = facts.adjacentInversions;
  if (
    inversions !== undefined &&
    (!Number.isSafeInteger(inversions) || inversions < 0 || inversions > Math.max(0, length - 1))
  ) throw new RangeError("order metadata adjacentInversions is invalid");
  if (
    facts.valueRange !== null &&
    (!Number.isSafeInteger(facts.valueRange) || facts.valueRange < 1 ||
      facts.valueRange > 0x1_0000_0000)
  ) throw new RangeError("order metadata valueRange is invalid");
  if (
    facts.ascending !== undefined &&
    (typeof facts.ascending !== "boolean" ||
      (inversions !== undefined && facts.ascending !== (inversions === 0)))
  ) throw new RangeError("order metadata ascending is inconsistent");
  if (facts.ascending === true || inversions === 0) return "already-sorted";
  if (
    inversions === undefined || length < NATIVE_PACKED_THRESHOLD ||
    inversions <= length >>> 6 ||
    (facts.valueRange !== null && facts.valueRange <= NARROW_VALUE_RANGE)
  ) return "native-packed";
  return "wasm-radix";
}

function copyIdentity(
  keys: Uint32Array,
  outputKeys: Uint32Array,
  outputRowIds: Uint32Array,
): void {
  outputKeys.set(keys);
  for (let index = 0; index < keys.length; index++) outputRowIds[index] = index;
}

function createLayout(capacity: number): Layout {
  const payloadOffset = alignTo(capacity * 4, 16);
  const scratchKeysOffset = alignTo(payloadOffset + capacity * 4, 16);
  const scratchPayloadsOffset = alignTo(scratchKeysOffset + capacity * 4, 16);
  const histogramOffset = alignTo(scratchPayloadsOffset + capacity * 4, 16);
  const byteLength = histogramOffset + HISTOGRAM_BYTES;
  if (!Number.isSafeInteger(byteLength) || byteLength > WASM_PAGE_BYTES * 65_536) {
    throw new RangeError("radix order workspace exceeds the Wasm memory limit");
  }
  return { payloadOffset, scratchKeysOffset, scratchPayloadsOffset, histogramOffset, byteLength };
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
  return modulePromise ??= loadModule(new URL("./radix_order_u32.wasm", import.meta.url));
}

async function loadModule(url: URL): Promise<WebAssembly.Module> {
  const deno = (globalThis as typeof globalThis & {
    Deno?: { readFile(path: URL): Promise<Uint8Array> };
  }).Deno;
  if (url.protocol === "file:" && deno !== undefined) {
    return await WebAssembly.compile(await deno.readFile(url) as BufferSource);
  }
  interface NodeProcess {
    getBuiltinModule?(name: string): { readFileSync(path: URL): Uint8Array };
  }
  const nodeProcess = (globalThis as typeof globalThis & { process?: NodeProcess }).process;
  const fileSystem = nodeProcess?.getBuiltinModule?.("node:fs");
  if (url.protocol === "file:" && fileSystem !== undefined) {
    return new WebAssembly.Module(fileSystem.readFileSync(url) as BufferSource);
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to load radix order Wasm: ${response.status}`);
  return await WebAssembly.compile(await response.arrayBuffer());
}
