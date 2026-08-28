const root = new URL("../", import.meta.url);

Deno.test("workspace packages keep explicit public boundaries", async () => {
  const rootPackage = await readJson<{ private?: boolean }>(new URL("package.json", root));
  assertEquals(rootPackage.private, true);

  const expectedPackages = new Map([
    ["jsimd", "@mizchi/jsimd"],
    ["shared", "@mizchi/jsimd-shared"],
    ["columnar", "@mizchi/jsimd-columnar"],
    ["bench", "@mizchi/jsimd-bench"],
  ]);

  for (const [directory, name] of expectedPackages) {
    const manifest = await readJson<{ name?: string }>(
      new URL(`packages/${directory}/package.json`, root),
    );
    assertEquals(manifest.name, name);
  }
});

Deno.test("every publishable package rebuilds its payload before packing", async () => {
  for (const directory of ["jsimd", "shared", "columnar"]) {
    const manifest = await readJson<{
      files?: readonly string[];
      private?: boolean;
      scripts?: Record<string, string>;
    }>(new URL(`packages/${directory}/package.json`, root));
    assertEquals(manifest.private, undefined);
    assertEquals(Array.isArray(manifest.files), true);
    assertEquals(typeof manifest.scripts?.prepack, "string");
  }
});

Deno.test("implementation sources live behind their package boundaries", async () => {
  await assertFile(new URL("packages/jsimd/src/bitmap/mod.ts", root));
  await assertFile(new URL("packages/shared/src/mod.ts", root));
  await assertFile(new URL("packages/columnar/src/mod.ts", root));
  await assertFile(new URL("packages/bench/src/result.ts", root));
});

async function readJson<T>(url: URL): Promise<T> {
  return JSON.parse(await Deno.readTextFile(url)) as T;
}

async function assertFile(url: URL): Promise<void> {
  assertEquals((await Deno.stat(url)).isFile, true);
}

function assertEquals<T>(actual: T, expected: T): void {
  if (actual !== expected) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
