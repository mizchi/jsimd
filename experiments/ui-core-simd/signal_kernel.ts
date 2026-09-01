export interface SignalKernel extends WebAssembly.Exports {
  union_subscriber_rows(
    matrix: number,
    signalIds: number,
    signalCount: number,
    paddedWords: number,
    output: number,
  ): void;
}

let modulePromise: Promise<WebAssembly.Module> | undefined;

export async function instantiateSignalKernel(memory: WebAssembly.Memory): Promise<SignalKernel> {
  modulePromise ??= compileModule(new URL("./signals.wasm", import.meta.url));
  const instance = await WebAssembly.instantiate(await modulePromise, { jsimd: { memory } });
  return instance.exports as SignalKernel;
}

async function compileModule(url: URL): Promise<WebAssembly.Module> {
  if (url.protocol === "file:") {
    const deno = (globalThis as { Deno?: { readFile(path: URL): Promise<Uint8Array> } }).Deno;
    if (deno === undefined) throw new Error("file: Wasm loading requires Deno");
    return await WebAssembly.compile(await deno.readFile(url) as BufferSource);
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to load signal Wasm module: ${response.status}`);
  return await WebAssembly.compile(await response.arrayBuffer());
}
