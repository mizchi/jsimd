import { contentType, resolveStaticAsset } from "./browser_runner.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("browser benchmark runner resolves only fixture-local assets", () => {
  const root = new URL("file:///tmp/jsimd-fixture/");
  assert(resolveStaticAsset(root, "/").href === "file:///tmp/jsimd-fixture/index.html", "index");
  assert(
    resolveStaticAsset(root, "/assets/kernel.wasm").href ===
      "file:///tmp/jsimd-fixture/assets/kernel.wasm",
    "nested asset",
  );
  assertThrows(() => resolveStaticAsset(root, "/../secret"));
  assertThrows(() => resolveStaticAsset(root, "/%2e%2e/secret"));
});

Deno.test("browser benchmark runner serves explicit web asset MIME types", () => {
  assert(contentType("index.html") === "text/html; charset=utf-8", "html");
  assert(contentType("index.js") === "text/javascript; charset=utf-8", "javascript");
  assert(contentType("kernel.wasm") === "application/wasm", "wasm");
  assert(contentType("data.json") === "application/json; charset=utf-8", "json");
});

function assertThrows(operation: () => unknown): void {
  try {
    operation();
  } catch {
    return;
  }
  throw new Error("expected operation to throw");
}
