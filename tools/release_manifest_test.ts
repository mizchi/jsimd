const root = new URL("../", import.meta.url);
const packageRoot = new URL("packages/jsimd/", root);

Deno.test("jsimd public source directories match npm and Deno exports", async () => {
  const npm = await readJson<{ exports: Record<string, string> }>(
    new URL("package.json", packageRoot),
  );
  const deno = await readJson<{ exports: Record<string, string> }>(
    new URL("deno.json", packageRoot),
  );

  const npmEntries = entriesFromExports(npm.exports, /^\.\/dist\/([^/]+)\/mod\.js$/);
  const denoEntries = entriesFromExports(deno.exports, /^\.\/src\/([^/]+)\/mod\.ts$/);
  assertArrayEquals(denoEntries, npmEntries, "npm and Deno exports");

  const sourceEntries: string[] = [];
  for await (const entry of Deno.readDir(new URL("src/", packageRoot))) {
    if (!entry.isDirectory || entry.name === "internal") continue;
    if (await isFile(new URL(`src/${entry.name}/mod.ts`, packageRoot))) {
      sourceEntries.push(entry.name);
    }
  }
  assertArrayEquals(sourceEntries.sort(), npmEntries, "public source directories and exports");
});

Deno.test("jsimd uses Zig kernels except for the hand-written bytes WAT", async () => {
  const npm = await readJson<{ exports: Record<string, string> }>(
    new URL("package.json", packageRoot),
  );
  const entries = entriesFromExports(npm.exports, /^\.\/dist\/([^/]+)\/mod\.js$/);
  if (entries.includes("json")) throw new Error("removed json export is still public");
  let zigKernelCount = 0;
  let watKernelCount = 0;

  for (const entry of entries) {
    if (!await isFile(new URL(`src/${entry}/kernels.wasm`, packageRoot))) continue;
    if (entry === "bytes") {
      watKernelCount++;
      if (!await isFile(new URL(`src/${entry}/kernels.wat`, packageRoot))) {
        throw new Error(`${entry}: missing hand-written WAT kernel source`);
      }
      if (await isFile(new URL(`src/${entry}/kernels.zig`, packageRoot))) {
        throw new Error(`${entry}: Zig source must not shadow the hand-written WAT`);
      }
      continue;
    }
    zigKernelCount++;
    if (!await isFile(new URL(`src/${entry}/kernels.zig`, packageRoot))) {
      throw new Error(`${entry}: missing Zig kernel source`);
    }
    if (await isFile(new URL(`src/${entry}/kernels.wat`, packageRoot))) {
      throw new Error(`${entry}: obsolete WAT kernel source remains`);
    }
  }
  if (zigKernelCount !== 30 || watKernelCount !== 1) {
    throw new Error(
      `expected 30 Zig kernels and 1 WAT kernel, found ${zigKernelCount} and ${watKernelCount}`,
    );
  }

  for (const helper of ["wavelet_exports.zig", "wavelet_kernel.zig"]) {
    if (!await isFile(new URL(`src/internal/${helper}`, packageRoot))) {
      throw new Error(`missing shared Zig source: ${helper}`);
    }
  }
});

Deno.test("every jsimd export emits its complete release payload", async () => {
  const npm = await readJson<{ exports: Record<string, string> }>(
    new URL("package.json", packageRoot),
  );
  const entries = entriesFromExports(npm.exports, /^\.\/dist\/([^/]+)\/mod\.js$/);

  for (const entry of entries) {
    const sourceDirectory = new URL(`src/${entry}/`, packageRoot);
    if (!await hasTestFile(sourceDirectory)) {
      throw new Error(`${entry}: no colocated correctness test`);
    }
    const paths = [
      `src/${entry}/mod.ts`,
      `src/${entry}/README.md`,
      `dist/${entry}/mod.js`,
      `dist/${entry}/mod.d.ts`,
      `dist/${entry}/README.md`,
    ];
    if (await isFile(new URL(`src/${entry}/kernels.wasm`, packageRoot))) {
      paths.push(
        `src/${entry}/kernels.wasm`,
        `src/${entry}/kernels.d.wasm.ts`,
        `dist/${entry}/kernels.wasm`,
      );
      if (entry === "bytes") {
        paths.push(`src/${entry}/kernels.wat`, `dist/${entry}/kernels.wat`);
      } else {
        paths.push(`src/${entry}/kernels.zig`, `dist/${entry}/kernels.zig`);
      }
    }
    if (await isFile(new URL(`src/${entry}/THIRD_PARTY_LICENSES.txt`, packageRoot))) {
      paths.push(`dist/${entry}/THIRD_PARTY_LICENSES.txt`);
    }
    for (const path of paths) {
      if (!await isFile(new URL(path, packageRoot))) {
        throw new Error(`${entry}: missing release file ${path}`);
      }
    }
    if (entry !== "bytes" && await isFile(new URL(`dist/${entry}/kernels.wat`, packageRoot))) {
      throw new Error(`${entry}: obsolete WAT source emitted in release payload`);
    }
  }

  for (const helper of ["wavelet_exports.zig", "wavelet_kernel.zig"]) {
    if (!await isFile(new URL(`dist/internal/${helper}`, packageRoot))) {
      throw new Error(`missing shared Zig release source: ${helper}`);
    }
  }
});

Deno.test("jsimd package README local links resolve after workspace moves", async () => {
  const readmeUrl = new URL("README.md", packageRoot);
  const readme = await Deno.readTextFile(readmeUrl);
  const targets = Array.from(readme.matchAll(/\[[^\]]+\]\(([^)]+\.md)\)/g), (match) => match[1]!);
  if (targets.length === 0) throw new Error("README contains no local Markdown links");

  for (const target of targets) {
    if (/^[a-z]+:/i.test(target)) continue;
    if (!await isFile(new URL(target, readmeUrl))) {
      throw new Error(`README has a broken local link: ${target}`);
    }
  }
});

function entriesFromExports(exports: Record<string, string>, pattern: RegExp): string[] {
  return Object.entries(exports).map(([name, target]) => {
    const match = pattern.exec(target);
    if (!match) throw new Error(`${name}: unsupported export target ${target}`);
    if (name !== `./${match[1]}`) {
      throw new Error(`${name}: export name and target directory differ`);
    }
    return match[1]!;
  }).sort();
}

async function readJson<T>(url: URL): Promise<T> {
  return JSON.parse(await Deno.readTextFile(url)) as T;
}

async function isFile(url: URL): Promise<boolean> {
  try {
    return (await Deno.stat(url)).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function hasTestFile(directory: URL): Promise<boolean> {
  for await (const entry of Deno.readDir(directory)) {
    if (entry.isFile && entry.name.endsWith("_test.ts")) return true;
  }
  return false;
}

function assertArrayEquals(actual: readonly string[], expected: readonly string[], label: string) {
  if (
    actual.length !== expected.length || actual.some((value, index) => value !== expected[index])
  ) {
    throw new Error(`${label}: expected ${expected.join(",")}, got ${actual.join(",")}`);
  }
}
