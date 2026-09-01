import * as validator from "./mod.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${message}: expected ${right}, got ${left}`);
}

Deno.test("the public root exposes only the SIMD validator runtime", () => {
  assertEquals(Object.keys(validator).sort(), [
    "compileSimd",
    "float32Array",
    "float64Array",
    "int32Array",
    "maxValue",
    "minValue",
    "uint32Array",
    "uint8Array",
  ], "root runtime exports");
});

Deno.test("SIMD constructors reject unsupported forged actions", () => {
  let found: unknown;
  try {
    validator.int32Array({ kind: "integer" } as never);
  } catch (error) {
    found = error;
  }
  assert(found instanceof TypeError, "unsupported SIMD action must throw");
});
