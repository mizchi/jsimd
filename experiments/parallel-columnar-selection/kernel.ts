import { instantiateSharedModule } from "@mizchi/jsimd-shared";

export interface SelectionKernels extends WebAssembly.Exports {
  scan_i32_between_mask(
    values: number,
    length: number,
    minimum: number,
    maximum: number,
    mask: number,
  ): void;
  mask_and(left: number, right: number, paddedWords: number): void;
  aggregate_i32_mask(values: number, length: number, mask: number, result: number): void;
}

let modulePromise: Promise<WebAssembly.Module> | undefined;

export async function instantiateSelectionKernels(
  memory: WebAssembly.Memory,
): Promise<SelectionKernels> {
  modulePromise ??= compileModule(new URL("./kernels.wasm", import.meta.url));
  return instantiateSharedModule<SelectionKernels>(await modulePromise, memory);
}

async function compileModule(url: URL): Promise<WebAssembly.Module> {
  if (url.protocol === "file:") {
    return await WebAssembly.compile(await Deno.readFile(url) as BufferSource);
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to load selection Wasm module: ${response.status}`);
  return await WebAssembly.compile(await response.arrayBuffer());
}
