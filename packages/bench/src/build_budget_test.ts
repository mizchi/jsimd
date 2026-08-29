import { checkBuildBudgets, measureFixtureGzip } from "./build_budget.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("build budget measures gzip assets and enforces deterministic ceilings", async () => {
  const directory = await Deno.makeTempDir({ prefix: "jsimd-budget-" });
  const root = new URL(`file://${directory}/`);
  try {
    await Deno.mkdir(new URL("fixture/dist/assets/", root), { recursive: true });
    await Deno.writeTextFile(new URL("fixture/dist/assets/index.js", root), "export const x = 1;");
    await Deno.writeFile(
      new URL("fixture/dist/assets/kernel.wasm", root),
      new Uint8Array([0, 97, 115, 109]),
    );
    await Deno.writeTextFile(new URL("primary_test.ts", root), "// correctness contract\n");
    const measured = await measureFixtureGzip(new URL("fixture/dist/assets/", root));
    assert(measured.jsGzipBytes > 0 && measured.wasmGzipBytes > 0, "gzip sizes");
    const summaries = await checkBuildBudgets(root, {
      schemaVersion: 1,
      fixtures: [{
        name: "fixture",
        path: "fixture/dist/assets",
        jsMaxGzipBytes: measured.jsGzipBytes,
        wasmMaxGzipBytes: measured.wasmGzipBytes,
      }],
      requiredCorrectnessTests: ["primary_test.ts"],
    }, ["./fixture"]);
    assert(summaries.length === 1, "fixture checked");
    await assertRejects(() =>
      checkBuildBudgets(root, {
        schemaVersion: 1,
        fixtures: [{
          name: "fixture",
          path: "fixture/dist/assets",
          jsMaxGzipBytes: measured.jsGzipBytes - 1,
          wasmMaxGzipBytes: measured.wasmGzipBytes,
        }],
        requiredCorrectnessTests: ["primary_test.ts"],
      }, ["./fixture"])
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("build budget permits an explicit zero-Wasm dynamic compiler fixture", async () => {
  const directory = await Deno.makeTempDir({ prefix: "jsimd-js-only-budget-" });
  const root = new URL(`file://${directory}/`);
  try {
    await Deno.mkdir(new URL("fixture/dist/assets/", root), { recursive: true });
    await Deno.writeTextFile(
      new URL("fixture/dist/assets/index.js", root),
      "export const compile = WebAssembly.compile;",
    );
    await Deno.writeTextFile(new URL("primary_test.ts", root), "// correctness contract\n");
    const measured = await measureFixtureGzip(new URL("fixture/dist/assets/", root));
    assert(measured.jsGzipBytes > 0, "JavaScript gzip size");
    assert(measured.wasmGzipBytes === 0, "no static Wasm asset");
    const summaries = await checkBuildBudgets(root, {
      schemaVersion: 1,
      fixtures: [{
        name: "fixture",
        path: "fixture/dist/assets",
        jsMaxGzipBytes: measured.jsGzipBytes,
        wasmMaxGzipBytes: 0,
      }],
      requiredCorrectnessTests: ["primary_test.ts"],
    }, ["./fixture"]);
    assert(summaries.length === 1, "JS-only fixture checked");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

async function assertRejects(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error("expected operation to reject");
}
