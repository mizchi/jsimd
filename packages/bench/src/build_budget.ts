export interface FixtureBudget {
  readonly name: string;
  readonly path: string;
  readonly jsMaxGzipBytes: number;
  readonly wasmMaxGzipBytes: number;
}

export interface BuildBudgetManifest {
  readonly schemaVersion: 1;
  readonly fixtures: readonly FixtureBudget[];
  readonly requiredCorrectnessTests: readonly string[];
}

export interface FixtureGzipSize {
  readonly jsGzipBytes: number;
  readonly wasmGzipBytes: number;
}

export async function measureFixtureGzip(directory: URL): Promise<FixtureGzipSize> {
  let jsGzipBytes = 0;
  let wasmGzipBytes = 0;
  for await (const file of files(directory)) {
    const bytes = await Deno.readFile(file);
    const gzipBytes = await gzipSize(bytes);
    if (file.pathname.endsWith(".js")) jsGzipBytes += gzipBytes;
    if (file.pathname.endsWith(".wasm")) wasmGzipBytes += gzipBytes;
  }
  if (jsGzipBytes === 0) {
    throw new Error(`${directory.pathname} must contain a JavaScript asset`);
  }
  return Object.freeze({ jsGzipBytes, wasmGzipBytes });
}

export async function checkBuildBudgets(
  root: URL,
  manifest: BuildBudgetManifest,
  publicExports: readonly string[],
): Promise<readonly string[]> {
  if (manifest.schemaVersion !== 1) throw new RangeError("unsupported build budget version");
  const names = manifest.fixtures.map((fixture) => fixture.name).sort();
  const expected = publicExports.map((name) => name.replace(/^\.\//, "")).sort();
  if (names.join("\n") !== expected.join("\n")) {
    throw new Error("build budgets must cover every public package subpath exactly once");
  }
  const summaries: string[] = [];
  for (const fixture of manifest.fixtures) {
    positiveInteger(fixture.jsMaxGzipBytes, `${fixture.name} JS budget`);
    nonNegativeInteger(fixture.wasmMaxGzipBytes, `${fixture.name} Wasm budget`);
    const size = await measureFixtureGzip(new URL(`${fixture.path.replace(/\/$/, "")}/`, root));
    if (size.jsGzipBytes > fixture.jsMaxGzipBytes) {
      throw new Error(
        `${fixture.name} JS gzip ${size.jsGzipBytes} exceeds ${fixture.jsMaxGzipBytes}`,
      );
    }
    if (size.wasmGzipBytes > fixture.wasmMaxGzipBytes) {
      throw new Error(
        `${fixture.name} Wasm gzip ${size.wasmGzipBytes} exceeds ${fixture.wasmMaxGzipBytes}`,
      );
    }
    summaries.push(`${fixture.name}: ${size.jsGzipBytes} JS + ${size.wasmGzipBytes} Wasm gzip`);
  }
  for (const path of manifest.requiredCorrectnessTests) {
    const stat = await Deno.stat(new URL(path, root));
    if (!stat.isFile) throw new Error(`${path} must be a correctness test file`);
  }
  return Object.freeze(summaries);
}

export async function gzipSize(bytes: Uint8Array): Promise<number> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return (await new Response(stream).arrayBuffer()).byteLength;
}

async function* files(directory: URL): AsyncGenerator<URL> {
  for await (const entry of Deno.readDir(directory)) {
    const url = new URL(`${entry.name}${entry.isDirectory ? "/" : ""}`, directory);
    if (entry.isDirectory) yield* files(url);
    else if (entry.isFile && (entry.name.endsWith(".js") || entry.name.endsWith(".wasm"))) {
      yield url;
    }
  }
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function nonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}
