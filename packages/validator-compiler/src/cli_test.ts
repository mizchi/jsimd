import { isMainModule, parseArgs } from "./cli.ts";

Deno.test("CLI defaults to Wasm and requires an explicit JavaScript fallback", () => {
  const wasm = parseArgs(["schema.json", "--out", "generated/schema"]);
  assertEquals(wasm.backend, "wasm");
  assertEquals(wasm.target, "boolean");
  assertEquals(wasm.wasmOpt, false);

  const optimized = parseArgs([
    "schemas.ts",
    "--out",
    "generated/schemas",
    "--wasm-opt",
  ]);
  assertEquals(optimized.wasmOpt, true);

  const javascript = parseArgs([
    "schema.json",
    "--out",
    "generated/schema",
    "--javascript",
  ]);
  assertEquals(javascript.backend, "javascript");
  assertEquals(javascript.target, "standard");

  assertThrows(
    () => parseArgs(["schema.json", "--out", "generated/schema", "--wasm"]),
    "unknown option: --wasm",
  );
  assertThrows(
    () =>
      parseArgs([
        "schema.json",
        "--out",
        "generated/schema",
        "--javascript",
        "--wasm-opt",
      ]),
    "--wasm-opt requires the Wasm backend",
  );
});

Deno.test("CLI main detection follows an npm-style executable symlink", async () => {
  const directory = await Deno.makeTempDir({ prefix: "jsimd-validator-cli-" });
  try {
    const target = `${directory}/cli.js`;
    const executable = `${directory}/jsimd-validator-compiler`;
    await Deno.writeTextFile(target, "export {};\n");
    await Deno.symlink(target, executable);
    assert(await isMainModule(new URL(`file://${target}`).href, executable));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error("expected condition to be true");
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`expected ${expected}, got ${actual}`);
}

function assertThrows(action: () => unknown, message: string): void {
  try {
    action();
  } catch (error) {
    if (error instanceof Error && error.message.includes(message)) return;
    throw error;
  }
  throw new Error(`expected error containing ${JSON.stringify(message)}`);
}
