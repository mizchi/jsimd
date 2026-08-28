import { instantiateSharedModule } from "@mizchi/jsimd-shared";

export interface ParallelBloomKernels extends WebAssembly.Exports {
  add_many(blocks: number, blockCount: number, keys: number, length: number): void;
  may_contain_many(
    blocks: number,
    blockCount: number,
    keys: number,
    output: number,
    length: number,
  ): number;
}

let modulePromise: Promise<WebAssembly.Module> | undefined;

export function compileParallelBloomModule(): Promise<WebAssembly.Module> {
  return modulePromise ??= compileModule(new URL("./kernels.wasm", import.meta.url));
}

export function instantiateParallelBloomKernels(
  module: WebAssembly.Module,
  memory: WebAssembly.Memory,
): ParallelBloomKernels {
  return instantiateSharedModule<ParallelBloomKernels>(module, memory);
}

async function compileModule(url: URL): Promise<WebAssembly.Module> {
  if (url.protocol === "file:") {
    return await WebAssembly.compile(await Deno.readFile(url) as BufferSource);
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to load parallel Bloom Wasm: ${response.status}`);
  return await WebAssembly.compile(await response.arrayBuffer());
}
