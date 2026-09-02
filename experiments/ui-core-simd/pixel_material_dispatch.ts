interface PixelMaterialDispatchExports extends WebAssembly.Exports {
  table_checksum(cells: number, count: number, table: number): number;
  specialized_simd_checksum(cells: number, count: number, materialCount: number): number;
}

let modulePromise: Promise<WebAssembly.Module> | undefined;

/** Benchmark-only comparison of direct material tables and growing specialized SIMD masks. */
export class WasmPixelMaterialDispatch {
  readonly memory: WebAssembly.Memory;
  readonly cells: Uint32Array;
  readonly #tableOffset: number;
  readonly #kernel: PixelMaterialDispatchExports;

  private constructor(
    memory: WebAssembly.Memory,
    cellCount: number,
    tableOffset: number,
    kernel: PixelMaterialDispatchExports,
  ) {
    this.memory = memory;
    this.cells = new Uint32Array(memory.buffer, 0, cellCount);
    this.#tableOffset = tableOffset;
    this.#kernel = kernel;
    const table = new Uint8Array(memory.buffer, tableOffset, 256);
    for (let material = 0; material < table.length; material++) table[material] = material;
  }

  static async create(cellCount: number): Promise<WasmPixelMaterialDispatch> {
    if (!Number.isSafeInteger(cellCount) || cellCount < 4 || cellCount % 4 !== 0) {
      throw new RangeError("material dispatch cell count must be a positive SIMD multiple");
    }
    const tableOffset = align16(cellCount * Uint32Array.BYTES_PER_ELEMENT);
    const memory = new WebAssembly.Memory({ initial: Math.ceil((tableOffset + 256) / 65_536) });
    modulePromise ??= compileModule(new URL("./pixel_material_dispatch.wasm", import.meta.url));
    const instance = await WebAssembly.instantiate(await modulePromise, { jsimd: { memory } });
    return new WasmPixelMaterialDispatch(
      memory,
      cellCount,
      tableOffset,
      instance.exports as PixelMaterialDispatchExports,
    );
  }

  tableChecksum(): number {
    return this.#kernel.table_checksum(0, this.cells.length, this.#tableOffset) >>> 0;
  }

  specializedSimdChecksum(materialCount: number): number {
    if (!Number.isSafeInteger(materialCount) || materialCount < 1 || materialCount > 256) {
      throw new RangeError("material count must be between 1 and 256");
    }
    return this.#kernel.specialized_simd_checksum(0, this.cells.length, materialCount) >>> 0;
  }
}

function align16(value: number): number {
  return (value + 15) & ~15;
}

async function compileModule(url: URL): Promise<WebAssembly.Module> {
  if (url.protocol === "file:") {
    const deno = (globalThis as { Deno?: { readFile(path: URL): Promise<Uint8Array> } }).Deno;
    if (deno === undefined) throw new Error("file: Wasm loading requires Deno");
    return await WebAssembly.compile(await deno.readFile(url) as BufferSource);
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to load material dispatch Wasm: ${response.status}`);
  return await WebAssembly.compile(await response.arrayBuffer());
}
