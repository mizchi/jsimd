import {
  absolute,
  add,
  constant,
  createF32FusionCompiler,
  input,
  maximum,
  minimum,
  multiply,
  relu,
  supportsF32Fusion,
} from "../f32-fusion/mod.ts";
import { assertClose, assertEquals } from "../../test/assert.ts";

Deno.test("F32FusionCompiler emits and executes one fused SIMD pass", async () => {
  using compiler = createF32FusionCompiler({ maxModules: 4 });
  const expression = relu(
    add(
      add(multiply(constant(1.5), input(0)), multiply(constant(-0.5), input(1))),
      constant(2),
    ),
  );
  const compiled = await compiler.compile(expression, 2);
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = await compiled.instantiate(memory);
  const left = new Float32Array([1, -2, 3, 4, -5, 6, 7]);
  const right = new Float32Array([2, 4, -6, 8, 10, -12, 14]);
  const leftPointer = 0;
  const rightPointer = 64;
  const outputPointer = 128;
  new Float32Array(memory.buffer, leftPointer, left.length).set(left);
  new Float32Array(memory.buffer, rightPointer, right.length).set(right);

  kernel.run([leftPointer, rightPointer], outputPointer, left.length);

  const actual = new Float32Array(memory.buffer, outputPointer, left.length);
  for (let index = 0; index < actual.length; index++) {
    const expected = Math.max(0, Math.fround(1.5 * left[index]! - 0.5 * right[index]! + 2));
    assertClose(actual[index]!, expected, 1e-6, `index=${index}`);
  }
  assertEquals(WebAssembly.validate(compiled.bytes), true, "generated module validates");
  assertEquals(compiled.bytes.includes(0xfd), true, "generated module contains SIMD prefix");
});

Deno.test("F32FusionKernel supports abs, min, max, and in-place output", async () => {
  using compiler = createF32FusionCompiler();
  const expression = maximum(constant(-3), minimum(constant(4), absolute(input(0))));
  const compiled = await compiler.compile(expression, 1);
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = await compiled.instantiate(memory);
  const values = new Float32Array(memory.buffer);
  const inputValues = [-10, -2, 0, 3, 9];
  values.set(inputValues);

  kernel.run([0], 0, inputValues.length);

  assertEquals(
    Array.from(values.subarray(0, inputValues.length)).join(","),
    "4,2,0,3,4",
    "in-place unary and min/max result",
  );
});

Deno.test("F32FusionKernel accepts an empty range", async () => {
  using compiler = createF32FusionCompiler();
  const compiled = await compiler.compile(add(input(0), constant(1)), 1);
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = await compiled.instantiate(memory);
  const values = new Float32Array(memory.buffer);
  values[0] = 42;

  kernel.run([0], 0, 0);

  assertEquals(values[0], 42, "empty range leaves memory unchanged");
});

Deno.test("F32FusionCompiler bounds its LRU and disposes its cache owner", async () => {
  const compiler = createF32FusionCompiler({ maxModules: 2 });
  const first = await compiler.compile(add(input(0), constant(1)), 1);
  const second = await compiler.compile(add(input(0), constant(2)), 1);
  assertEquals(compiler.cacheStats().modules, 2, "cached modules");
  assertEquals(compiler.cacheStats().maximum, 2, "cache maximum");
  assertEquals(await compiler.compile(add(input(0), constant(1)), 1), first, "cache hit");
  await compiler.compile(add(input(0), constant(3)), 1);
  assertEquals(await compiler.compile(add(input(0), constant(1)), 1), first, "LRU promotion");
  if (await compiler.compile(add(input(0), constant(2)), 1) === second) {
    throw new Error("least-recently-used module was not evicted");
  }

  compiler[Symbol.dispose]();
  assertEquals(compiler.cacheStats().modules, 0, "disposed cache");
  await assertRejects(
    () => compiler.compile(input(0), 1),
    Error,
    "disposed",
  );
});

Deno.test("F32FusionKernel validates its dynamic pointer contract", async () => {
  using compiler = createF32FusionCompiler();
  const compiled = await compiler.compile(add(input(0), input(1)), 2);
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = await compiled.instantiate(memory);
  assertThrows(() => kernel.run([0], 32, 4), RangeError, "input pointers");
  assertThrows(() => kernel.run([0, -1], 32, 4), RangeError, "pointer");
  assertThrows(() => kernel.run([0, 16], 32, -1), RangeError, "length");
  assertThrows(
    () => kernel.run([0, 16], memory.buffer.byteLength - 4, 2),
    RangeError,
    "range",
  );
});

Deno.test("F32FusionCompiler rejects invalid options and expressions", async () => {
  assertThrows(() => createF32FusionCompiler({ maxModules: 0 }), RangeError, "maxModules");
  using compiler = createF32FusionCompiler();
  await assertRejects(() => compiler.compile(input(1), 1), RangeError, "input index");
  await assertRejects(
    () => compiler.compile(constant(Number.POSITIVE_INFINITY), 1),
    RangeError,
    "finite",
  );
  await assertRejects(() => compiler.compile(input(0), 0), RangeError, "inputCount");

  let deep = input(0);
  for (let index = 0; index < 80; index++) deep = add(deep, constant(1));
  await assertRejects(() => compiler.compile(deep, 1), RangeError, "depth");
});

Deno.test("supportsF32Fusion probes dynamic Wasm SIMD compilation", async () => {
  assertEquals(await supportsF32Fusion(), true, "dynamic SIMD support");
});

function assertThrows(
  callback: () => unknown,
  expected: abstract new (...arguments_: never[]) => Error,
  includes: string,
): void {
  try {
    callback();
  } catch (error) {
    if (error instanceof expected && error.message.includes(includes)) return;
    throw error;
  }
  throw new Error(`expected ${expected.name} containing ${includes}`);
}

async function assertRejects(
  callback: () => Promise<unknown>,
  expected: abstract new (...arguments_: never[]) => Error,
  includes: string,
): Promise<void> {
  try {
    await callback();
  } catch (error) {
    if (error instanceof expected && error.message.includes(includes)) return;
    throw error;
  }
  throw new Error(`expected ${expected.name} containing ${includes}`);
}
