import { instantiateSharedModule } from "../../src/shared-buffer/mod.ts";

export interface HybridKernels extends WebAssembly.Exports {
  scan_i32_between_mask(
    values: number,
    length: number,
    minimum: number,
    maximum: number,
    mask: number,
  ): void;
  masked_squared_l2_top1_pdx64(
    vectors: number,
    query: number,
    count: number,
    dimensions: number,
    mask: number,
    scratch: number,
    result: number,
  ): void;
  masked_squared_l2_topk_pdx64(
    vectors: number,
    query: number,
    count: number,
    dimensions: number,
    mask: number,
    scratch: number,
    result: number,
    outputIds: number,
    outputDistances: number,
    k: number,
  ): number;
  masked_squared_l2_topk_pdx64_pruned(
    vectors: number,
    blockMinimums: number,
    blockMaximums: number,
    query: number,
    count: number,
    dimensions: number,
    mask: number,
    scratch: number,
    outputIds: number,
    outputDistances: number,
    k: number,
    stats: number,
  ): number;
  masked_hamming_top1(
    signatures: number,
    query: number,
    count: number,
    stride: number,
    mask: number,
    result: number,
  ): void;
  masked_hamming_topk(
    signatures: number,
    query: number,
    count: number,
    stride: number,
    mask: number,
    result: number,
    outputIds: number,
    outputDistances: number,
    k: number,
  ): number;
  pdx64_squared_l2_selected(
    vectors: number,
    query: number,
    ids: number,
    count: number,
    dimensions: number,
    output: number,
  ): void;
}

let modulePromise: Promise<WebAssembly.Module> | undefined;

export async function instantiateHybridKernels(
  memory: WebAssembly.Memory,
): Promise<HybridKernels> {
  modulePromise ??= compileModule(new URL("./kernels.wasm", import.meta.url));
  return instantiateSharedModule<HybridKernels>(await modulePromise, memory);
}

async function compileModule(url: URL): Promise<WebAssembly.Module> {
  const deno = (globalThis as typeof globalThis & {
    Deno?: { readFile(path: URL): Promise<Uint8Array> };
  }).Deno;
  if (url.protocol === "file:" && deno !== undefined) {
    return await WebAssembly.compile(await deno.readFile(url) as BufferSource);
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to load hybrid Wasm module: ${response.status}`);
  return await WebAssembly.compile(await response.arrayBuffer());
}
