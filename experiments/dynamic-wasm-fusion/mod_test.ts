import {
  absolute,
  add,
  compileF32Map,
  constant,
  input,
  maximum,
  minimum,
  multiply,
  relu,
} from "./mod.ts";

Deno.test("compileF32Map emits a valid Wasm binary and caches canonical expressions", async () => {
  const expression = relu(add(multiply(constant(2), input(0)), input(1)));
  const first = await compileF32Map(expression, 2);
  const second = await compileF32Map(expression, 2);

  assert(WebAssembly.validate(first.bytes), "generated module must validate");
  assertEquals(Array.from(first.bytes.subarray(0, 8)), [0, 97, 115, 109, 1, 0, 0, 0]);
  assert(first === second, "equivalent plans must reuse the compiled module");
  assert(first.bytes.includes(0xfd), "generated body must contain SIMD instructions");
  assertEquals(WebAssembly.Module.imports(first.module), [
    { module: "env", name: "memory", kind: "memory" },
  ]);
  assertEquals(WebAssembly.Module.exports(first.module), [{ name: "run", kind: "function" }]);
});

Deno.test("generated kernel evaluates SIMD blocks and a scalar tail", async () => {
  const expression = relu(
    add(
      add(multiply(constant(1.5), input(0)), multiply(constant(-0.5), input(1))),
      constant(2),
    ),
  );
  const compiled = await compileF32Map(expression, 2);
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = await compiled.instantiate(memory);
  const values = new Float32Array(memory.buffer);
  const leftPointer = 0;
  const rightPointer = 64;
  const outputPointer = 128;
  const length = 7;
  const left = [1, -2, 3, 4, -5, 6, 7];
  const right = [2, 4, 6, -8, 10, 12, -14];
  values.set(left, leftPointer / 4);
  values.set(right, rightPointer / 4);

  kernel.run(leftPointer, rightPointer, outputPointer, length);

  const actual = Array.from(values.subarray(outputPointer / 4, outputPointer / 4 + length));
  const expected = left.map((value, index) =>
    Math.fround(
      Math.max(0, Math.fround(Math.fround(1.5 * value) + Math.fround(-0.5 * right[index]!)) + 2),
    )
  );
  assertFloatArrayEquals(actual, expected);
});

Deno.test("generated kernel supports abs, min, max, and in-place output", async () => {
  const expression = maximum(
    constant(-3),
    minimum(constant(4), absolute(input(0))),
  );
  const compiled = await compileF32Map(expression, 1);
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = await compiled.instantiate(memory);
  const values = new Float32Array(memory.buffer);
  const data = [-10, -2, 0, 3, 9];
  values.set(data);

  kernel.run(0, 0, data.length);

  assertFloatArrayEquals(Array.from(values.subarray(0, data.length)), [4, 2, 0, 3, 4]);
});

Deno.test("generated kernel accepts an empty range", async () => {
  const compiled = await compileF32Map(add(input(0), constant(1)), 1);
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = await compiled.instantiate(memory);
  const values = new Float32Array(memory.buffer);
  values[0] = 42;

  kernel.run(0, 0, 0);

  assertEquals(values[0], 42);
});

Deno.test("compileF32Map rejects invalid plans before emitting code", async () => {
  await assertRejects(() => compileF32Map(input(1), 1), "input index");
  await assertRejects(() => compileF32Map(constant(Number.POSITIVE_INFINITY), 1), "finite");
  await assertRejects(() => compileF32Map(input(0), 0), "inputCount");

  let deep = input(0);
  for (let index = 0; index < 80; index++) deep = add(deep, constant(1));
  await assertRejects(() => compileF32Map(deep, 1), "depth");
});

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

async function assertRejects(operation: () => Promise<unknown>, includes: string): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof Error && error.message.includes(includes)) return;
    throw error;
  }
  throw new Error(`expected rejection containing ${includes}`);
}

function assertFloatArrayEquals(actual: readonly number[], expected: readonly number[]): void {
  assertEquals(actual.length, expected.length);
  for (let index = 0; index < actual.length; index++) {
    if (Object.is(actual[index], expected[index])) continue;
    if (Math.abs(actual[index]! - expected[index]!) <= 1e-6) continue;
    throw new Error(
      `float mismatch at ${index}: expected ${expected[index]}, received ${actual[index]}`,
    );
  }
}
