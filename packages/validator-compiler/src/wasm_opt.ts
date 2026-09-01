import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WasmOptOptions {
  readonly command?: string;
}

export async function optimizeWasm(
  source: Uint8Array,
  options: WasmOptOptions = {},
): Promise<Uint8Array> {
  const directory = await mkdtemp(join(tmpdir(), "jsimd-validator-wasm-opt-"));
  const input = join(directory, "input.wasm");
  const output = join(directory, "output.wasm");
  try {
    await writeFile(input, source);
    try {
      await execFileAsync(
        options.command ?? "wasm-opt",
        [input, "-o", output, "-Oz", "--enable-simd"],
        { maxBuffer: 1_000_000 },
      );
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined;
      if (code === "ENOENT") {
        throw new TypeError(
          "--wasm-opt requires Binaryen wasm-opt on PATH",
          { cause: error },
        );
      }
      throw error;
    }
    const optimized = new Uint8Array(await readFile(output));
    if (!WebAssembly.validate(optimized)) {
      throw new TypeError("wasm-opt produced an invalid Wasm module");
    }
    return optimized;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
