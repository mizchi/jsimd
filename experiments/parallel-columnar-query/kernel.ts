import { instantiateSharedModule } from "../../packages/jsimd/src/shared-buffer/mod.ts";

export interface QueryKernels extends WebAssembly.Exports {
  scan_i32_between_aggregate(
    pointer: number,
    length: number,
    minimum: number,
    maximum: number,
    resultPointer: number,
  ): void;
  scan_i32_between_group_by_u8(
    filterPointer: number,
    valuesPointer: number,
    groupsPointer: number,
    length: number,
    minimum: number,
    maximum: number,
    countsPointer: number,
    sumsPointer: number,
    minimumsPointer: number,
    maximumsPointer: number,
  ): void;
}

let modulePromise: Promise<WebAssembly.Module> | undefined;

export async function instantiateQueryKernels(
  memory: WebAssembly.Memory,
): Promise<QueryKernels> {
  modulePromise ??= compileModule(new URL("./kernels.wasm", import.meta.url));
  return instantiateSharedModule<QueryKernels>(await modulePromise, memory);
}

async function compileModule(url: URL): Promise<WebAssembly.Module> {
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
    return new WebAssembly.Module(fileSystem.readFileSync(url));
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to load query Wasm module: ${response.status}`);
  return await WebAssembly.compile(await response.arrayBuffer());
}
