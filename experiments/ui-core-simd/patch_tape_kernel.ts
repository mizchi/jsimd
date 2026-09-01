export interface PatchTapeKernel extends WebAssembly.Exports {
  collect_changed(
    current: number,
    previous: number,
    count: number,
    outputIds: number,
    outputValues: number,
  ): number;
}

let modulePromise: Promise<WebAssembly.Module> | undefined;

export async function instantiatePatchTapeKernel(
  memory: WebAssembly.Memory,
): Promise<PatchTapeKernel> {
  modulePromise ??= compileModule(new URL("./patch_tape.wasm", import.meta.url));
  const instance = await WebAssembly.instantiate(await modulePromise, { jsimd: { memory } });
  return instance.exports as PatchTapeKernel;
}

async function compileModule(url: URL): Promise<WebAssembly.Module> {
  if (url.protocol === "file:") {
    const deno = (globalThis as { Deno?: { readFile(path: URL): Promise<Uint8Array> } }).Deno;
    if (deno === undefined) throw new Error("file: Wasm loading requires Deno");
    return await WebAssembly.compile(await deno.readFile(url) as BufferSource);
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to load patch-tape Wasm module: ${response.status}`);
  return await WebAssembly.compile(await response.arrayBuffer());
}
