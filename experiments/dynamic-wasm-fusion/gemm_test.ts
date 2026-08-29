import {
  compileF32Gemm,
  compileF32GemmWithFallback,
  detectF32GemmRuntimeFeatures,
  type F32GemmPlan,
  packF32GemmRight,
  resolveF32GemmPlan,
} from "./mod.ts";

Deno.test("generated GEMM fuses alpha, beta, column bias, and ReLU across column tails", async () => {
  const plan: F32GemmPlan = {
    rows: 2,
    inner: 3,
    columns: 5,
    alpha: 1.5,
    beta: 0.25,
    bias: { kind: "columns" },
    activation: { kind: "relu" },
  };
  const compiled = await compileF32Gemm(plan);
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = await compiled.instantiate(memory);
  const a = new Float32Array([1, -2, 3, 4, 0.5, -1]);
  const b = new Float32Array([
    1,
    2,
    3,
    4,
    5,
    -1,
    0.5,
    2,
    -3,
    1,
    0.25,
    -2,
    1,
    0,
    4,
  ]);
  const initialC = new Float32Array([4, -4, 8, 1, -2, 3, 2, -1, 5, 7]);
  const bias = new Float32Array([-1, 0.5, 2, -3, 1]);
  const pointers = place(memory, [a, b, initialC, bias]);

  kernel.run(pointers[0]!, pointers[1]!, pointers[2]!, pointers[3]!);

  const actual = read(memory, pointers[2]!, plan.rows * plan.columns);
  const expected = referenceGemm(plan, a, b, initialC, bias);
  assertFloatArrayEquals(actual, expected);
  assert(WebAssembly.validate(compiled.bytes), "generated GEMM module must validate");
  assert(compiled.bytes.includes(0xfd), "generated GEMM must contain SIMD instructions");
});

Deno.test("generated GEMM skips C reads at beta zero and supports scalar bias plus clamp", async () => {
  const plan: F32GemmPlan = {
    rows: 1,
    inner: 2,
    columns: 4,
    beta: 0,
    bias: { kind: "scalar", value: 0.5 },
    activation: { kind: "clamp", minimum: -1, maximum: 2 },
  };
  const compiled = await compileF32Gemm(plan);
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = await compiled.instantiate(memory);
  const a = new Float32Array([2, -1]);
  const b = new Float32Array([1, 2, 3, 4, 4, 3, 2, 1]);
  const initialC = new Float32Array([NaN, NaN, NaN, NaN]);
  const pointers = place(memory, [a, b, initialC]);

  kernel.run(pointers[0]!, pointers[1]!, pointers[2]!, 0);

  const actual = read(memory, pointers[2]!, 4);
  assertFloatArrayEquals(actual, [-1, 1.5, 2, 2]);
});

Deno.test("compileF32Gemm caches identical plans and validates shape and epilogue", async () => {
  const plan: F32GemmPlan = { rows: 4, inner: 4, columns: 4 };
  const first = await compileF32Gemm(plan);
  const second = await compileF32Gemm({ rows: 4, inner: 4, columns: 4 });
  assert(first === second, "identical plans must reuse the compiled module");
  assertEquals(WebAssembly.Module.imports(first.module), [
    { module: "env", name: "memory", kind: "memory" },
  ]);
  assertEquals(WebAssembly.Module.exports(first.module), [{ name: "run", kind: "function" }]);

  await assertRejects(() => compileF32Gemm({ rows: -1, inner: 1, columns: 1 }), "rows");
  await assertRejects(
    () => compileF32Gemm({ rows: 1, inner: 1, columns: 1, alpha: Number.NaN }),
    "alpha",
  );
  await assertRejects(
    () =>
      compileF32Gemm({
        rows: 1,
        inner: 1,
        columns: 1,
        activation: { kind: "clamp", minimum: 2, maximum: 1 },
      }),
    "clamp",
  );
  await assertRejects(
    () => compileF32Gemm({ rows: 1, inner: 1, columns: 1, rowTile: 3 as 1 }),
    "rowTile",
  );
});

Deno.test("generated GEMM register tiles reuse B across rows without changing results", async () => {
  const rows = 9;
  const inner = 7;
  const columns = 37;
  const a = Float32Array.from(
    { length: rows * inner },
    (_, index) => ((index * 13 + 5) % 31 - 15) / 8,
  );
  const b = Float32Array.from(
    { length: inner * columns },
    (_, index) => ((index * 17 + 3) % 37 - 18) / 8,
  );
  const initialC = Float32Array.from(
    { length: rows * columns },
    (_, index) => ((index * 7 + 1) % 19 - 9) / 16,
  );
  const bias = Float32Array.from(
    { length: columns },
    (_, index) => (index % 9 - 4) / 16,
  );
  const basePlan = {
    rows,
    inner,
    columns,
    alpha: 0.75,
    beta: 0.25,
    bias: { kind: "columns" as const },
    activation: { kind: "clamp" as const, minimum: -2, maximum: 3 },
  };
  const expected = referenceGemm(basePlan, a, b, initialC, bias);
  const compiled = [];

  for (const rowTile of [1, 2, 4, 8] as const) {
    const kernelPlan: F32GemmPlan = { ...basePlan, rowTile };
    const candidate = await compileF32Gemm(kernelPlan);
    const memory = new WebAssembly.Memory({ initial: 1 });
    const pointers = place(memory, [a, b, initialC, bias]);
    const kernel = await candidate.instantiate(memory);
    kernel.run(pointers[0]!, pointers[1]!, pointers[2]!, pointers[3]!);
    assertFloatArrayEquals(
      read(memory, pointers[2]!, rows * columns),
      expected,
    );
    compiled.push(candidate);
  }

  assert(new Set(compiled).size === 4, "row tile must be part of the module cache key");
});

Deno.test("generated GEMM can opt into relaxed SIMD multiply-add", async () => {
  const plan: F32GemmPlan = {
    rows: 5,
    inner: 11,
    columns: 19,
    rowTile: 2,
    multiplyAdd: "relaxed",
  };
  const strict = await compileF32Gemm({ ...plan, multiplyAdd: "strict" });
  const relaxed = await compileF32Gemm(plan);
  assert(strict !== relaxed, "multiply-add mode must be part of the module cache key");
  const memory = new WebAssembly.Memory({ initial: 1 });
  const a = Float32Array.from(
    { length: plan.rows * plan.inner },
    (_, index) => ((index * 11 + 3) % 29 - 14) / 16,
  );
  const b = Float32Array.from(
    { length: plan.inner * plan.columns },
    (_, index) => ((index * 19 + 7) % 31 - 15) / 16,
  );
  const strictOutput = new Float32Array(plan.rows * plan.columns);
  const relaxedOutput = new Float32Array(plan.rows * plan.columns);
  const pointers = place(memory, [a, b, strictOutput, relaxedOutput]);
  const [strictKernel, relaxedKernel] = await Promise.all([
    strict.instantiate(memory),
    relaxed.instantiate(memory),
  ]);

  strictKernel.run(pointers[0]!, pointers[1]!, pointers[2]!, 0);
  relaxedKernel.run(pointers[0]!, pointers[1]!, pointers[3]!, 0);

  assertFloatArrayEquals(
    read(memory, pointers[3]!, relaxedOutput.length),
    read(memory, pointers[2]!, strictOutput.length),
  );
  assert(relaxed.bytes.includes(0x85), "relaxed module must encode opcode 0x105");
});

Deno.test("portable GEMM resolves unsupported relaxed SIMD to strict operations", async () => {
  const plan: F32GemmPlan = {
    rows: 8,
    inner: 8,
    columns: 8,
    rowTile: 4,
    multiplyAdd: "relaxed",
  };
  const strictPlan = resolveF32GemmPlan(plan, { relaxedSimd: false });
  const relaxedPlan = resolveF32GemmPlan(plan, { relaxedSimd: true });
  assertEquals(strictPlan.multiplyAdd, "strict");
  assertEquals(relaxedPlan.multiplyAdd, "relaxed");

  const portable = await compileF32GemmWithFallback(plan, { relaxedSimd: false });
  const strict = await compileF32Gemm({ ...plan, multiplyAdd: "strict" });
  assertEquals(portable.effectiveMultiplyAdd, "strict");
  assert(portable.compiled === strict, "strict fallback must reuse the canonical module cache");

  const detected = detectF32GemmRuntimeFeatures();
  assert(typeof detected.relaxedSimd === "boolean", "feature detection must be explicit");
});

Deno.test("generated GEMM can fully unroll a known inner dimension", async () => {
  const plan: F32GemmPlan = {
    rows: 5,
    inner: 7,
    columns: 13,
    rowTile: 4,
    innerLoop: "unrolled",
  };
  const looped = await compileF32Gemm({ ...plan, innerLoop: "loop" });
  const unrolled = await compileF32Gemm(plan);
  assert(looped !== unrolled, "inner-loop mode must be part of the module cache key");
  const memory = new WebAssembly.Memory({ initial: 1 });
  const a = Float32Array.from(
    { length: plan.rows * plan.inner },
    (_, index) => ((index * 5 + 1) % 17 - 8) / 8,
  );
  const b = Float32Array.from(
    { length: plan.inner * plan.columns },
    (_, index) => ((index * 7 + 3) % 23 - 11) / 8,
  );
  const loopedOutput = new Float32Array(plan.rows * plan.columns);
  const unrolledOutput = new Float32Array(plan.rows * plan.columns);
  const pointers = place(memory, [a, b, loopedOutput, unrolledOutput]);
  const [loopedKernel, unrolledKernel] = await Promise.all([
    looped.instantiate(memory),
    unrolled.instantiate(memory),
  ]);

  loopedKernel.run(pointers[0]!, pointers[1]!, pointers[2]!, 0);
  unrolledKernel.run(pointers[0]!, pointers[1]!, pointers[3]!, 0);

  assertFloatArrayEquals(
    read(memory, pointers[3]!, unrolledOutput.length),
    read(memory, pointers[2]!, loopedOutput.length),
  );
  assert(
    unrolled.bytes.byteLength > looped.bytes.byteLength,
    "unrolling must expose code-size cost",
  );
});

Deno.test("generated GEMM bounds complete inner-loop unrolling", async () => {
  await assertRejects(
    () =>
      compileF32Gemm({
        rows: 1,
        inner: 257,
        columns: 4,
        innerLoop: "unrolled",
      }),
    "fully unrolled inner dimension",
  );
  const bounded = await compileF32Gemm({
    rows: 1,
    inner: 4096,
    columns: 4,
    innerLoop: "unroll4",
  });
  assert(WebAssembly.validate(bounded.bytes), "bounded unrolling must remain available at large K");
});

Deno.test("generated GEMM supports bounded inner unrolling with a remainder", async () => {
  const basePlan: F32GemmPlan = {
    rows: 7,
    inner: 11,
    columns: 23,
    rowTile: 2,
  };
  const modes = ["loop", "unroll2", "unroll4", "unrolled"] as const;
  const compiled = await Promise.all(
    modes.map((innerLoop) => compileF32Gemm({ ...basePlan, innerLoop })),
  );
  assert(new Set(compiled).size === modes.length, "inner-loop modes need distinct cache keys");
  const memory = new WebAssembly.Memory({ initial: 1 });
  const a = Float32Array.from(
    { length: basePlan.rows * basePlan.inner },
    (_, index) => ((index * 13 + 1) % 37 - 18) / 16,
  );
  const b = Float32Array.from(
    { length: basePlan.inner * basePlan.columns },
    (_, index) => ((index * 17 + 5) % 41 - 20) / 16,
  );
  const outputs = modes.map(() => new Float32Array(basePlan.rows * basePlan.columns));
  const pointers = place(memory, [a, b, ...outputs]);

  for (let index = 0; index < compiled.length; index++) {
    const kernel = await compiled[index]!.instantiate(memory);
    kernel.run(pointers[0]!, pointers[1]!, pointers[index + 2]!, 0);
  }

  const expected = read(memory, pointers[2]!, outputs[0]!.length);
  for (let index = 1; index < modes.length; index++) {
    assertFloatArrayEquals(read(memory, pointers[index + 2]!, outputs[index]!.length), expected);
  }
  assert(
    compiled[1]!.bytes.byteLength < compiled[3]!.bytes.byteLength,
    "factor-two unrolling must remain smaller than full unrolling",
  );
  assert(
    compiled[2]!.bytes.byteLength < compiled[3]!.bytes.byteLength,
    "factor-four unrolling must remain smaller than full unrolling",
  );
});

Deno.test("generated GEMM consumes padded packed B panels across column and row tails", async () => {
  const basePlan: F32GemmPlan = {
    rows: 7,
    inner: 5,
    columns: 37,
    rowTile: 2,
    innerLoop: "unroll4",
    alpha: 0.75,
    beta: 0.25,
    bias: { kind: "columns" },
    activation: { kind: "relu" },
  };
  const rowMajor = await compileF32Gemm(basePlan);
  const packed = await compileF32Gemm({ ...basePlan, rightLayout: "packed-panels" });
  assert(rowMajor !== packed, "right layout must be part of the module cache key");
  const a = Float32Array.from(
    { length: basePlan.rows * basePlan.inner },
    (_, index) => ((index * 11 + 3) % 29 - 14) / 8,
  );
  const b = Float32Array.from(
    { length: basePlan.inner * basePlan.columns },
    (_, index) => ((index * 17 + 1) % 31 - 15) / 8,
  );
  const packedB = packF32GemmRight(basePlan, b);
  assertEquals(packedB.length, 3 * basePlan.inner * 16);
  const initialC = Float32Array.from(
    { length: basePlan.rows * basePlan.columns },
    (_, index) => (index % 13 - 6) / 16,
  );
  const rowMajorC = new Float32Array(initialC);
  const packedC = new Float32Array(initialC);
  const bias = Float32Array.from(
    { length: basePlan.columns },
    (_, index) => (index % 7 - 3) / 16,
  );
  const memory = new WebAssembly.Memory({ initial: 1 });
  const pointers = place(memory, [a, b, packedB, rowMajorC, packedC, bias]);
  const [rowMajorKernel, packedKernel] = await Promise.all([
    rowMajor.instantiate(memory),
    packed.instantiate(memory),
  ]);

  rowMajorKernel.run(pointers[0]!, pointers[1]!, pointers[3]!, pointers[5]!);
  packedKernel.run(pointers[0]!, pointers[2]!, pointers[4]!, pointers[5]!);

  assertFloatArrayEquals(
    read(memory, pointers[4]!, packedC.length),
    read(memory, pointers[3]!, rowMajorC.length),
  );
});

Deno.test("generated GEMM applies packed-B column blocking across block and shape tails", async () => {
  const basePlan: F32GemmPlan = {
    rows: 7,
    inner: 5,
    columns: 53,
    rowTile: 2,
    innerLoop: "unroll4",
    rightLayout: "packed-panels",
    alpha: 0.75,
    beta: 0.25,
    bias: { kind: "columns" },
    activation: { kind: "clamp", minimum: -3, maximum: 4 },
  };
  const unblocked = await compileF32Gemm(basePlan);
  const blocked = await compileF32Gemm({ ...basePlan, columnBlock: 32 });
  assert(unblocked !== blocked, "column block must be part of the module cache key");
  assert(
    !uint8ArraysEqual(unblocked.bytes, blocked.bytes),
    "column blocking must change the generated loop nest",
  );
  const a = Float32Array.from(
    { length: basePlan.rows * basePlan.inner },
    (_, index) => ((index * 13 + 3) % 31 - 15) / 8,
  );
  const b = Float32Array.from(
    { length: basePlan.inner * basePlan.columns },
    (_, index) => ((index * 19 + 1) % 37 - 18) / 8,
  );
  const packedB = packF32GemmRight(basePlan, b);
  const initialC = Float32Array.from(
    { length: basePlan.rows * basePlan.columns },
    (_, index) => (index % 17 - 8) / 16,
  );
  const unblockedC = new Float32Array(initialC);
  const blockedC = new Float32Array(initialC);
  const bias = Float32Array.from(
    { length: basePlan.columns },
    (_, index) => (index % 11 - 5) / 16,
  );
  const memory = new WebAssembly.Memory({ initial: 1 });
  const pointers = place(memory, [a, packedB, unblockedC, blockedC, bias]);
  const [unblockedKernel, blockedKernel] = await Promise.all([
    unblocked.instantiate(memory),
    blocked.instantiate(memory),
  ]);

  unblockedKernel.run(pointers[0]!, pointers[1]!, pointers[2]!, pointers[4]!);
  blockedKernel.run(pointers[0]!, pointers[1]!, pointers[3]!, pointers[4]!);

  assertFloatArrayEquals(
    read(memory, pointers[3]!, blockedC.length),
    read(memory, pointers[2]!, unblockedC.length),
  );
  await assertRejects(
    () => compileF32Gemm({ ...basePlan, rightLayout: "row-major", columnBlock: 32 }),
    "packed-panels",
  );
  await assertRejects(() => compileF32Gemm({ ...basePlan, columnBlock: 24 }), "multiple of 16");
});

function referenceGemm(
  plan: F32GemmPlan,
  a: Float32Array,
  b: Float32Array,
  initialC: Float32Array,
  columnBias: Float32Array,
): Float32Array {
  const output = new Float32Array(initialC);
  const alpha = plan.alpha ?? 1;
  const beta = plan.beta ?? 0;
  for (let row = 0; row < plan.rows; row++) {
    for (let column = 0; column < plan.columns; column++) {
      let value = beta === 0 ? 0 : Math.fround(beta * output[row * plan.columns + column]!);
      let dot = 0;
      for (let inner = 0; inner < plan.inner; inner++) {
        const product = Math.fround(
          a[row * plan.inner + inner]! * b[inner * plan.columns + column]!,
        );
        dot = Math.fround(dot + product);
      }
      value = Math.fround(value + (alpha === 1 ? dot : Math.fround(alpha * dot)));
      if (plan.bias?.kind === "columns") value = Math.fround(value + columnBias[column]!);
      else if (plan.bias?.kind === "scalar") value = Math.fround(value + plan.bias.value);
      if (plan.activation?.kind === "relu") value = Math.max(0, value);
      else if (plan.activation?.kind === "clamp") {
        value = Math.min(plan.activation.maximum, Math.max(plan.activation.minimum, value));
      }
      output[row * plan.columns + column] = value;
    }
  }
  return output;
}

function place(memory: WebAssembly.Memory, arrays: readonly Float32Array[]): number[] {
  let pointer = 0;
  const pointers: number[] = [];
  for (const array of arrays) {
    pointers.push(pointer);
    new Float32Array(memory.buffer, pointer, array.length).set(array);
    pointer = (pointer + array.byteLength + 15) & ~15;
  }
  return pointers;
}

function read(memory: WebAssembly.Memory, pointer: number, length: number): number[] {
  return Array.from(new Float32Array(memory.buffer, pointer, length));
}

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

function assertFloatArrayEquals(actual: ArrayLike<number>, expected: ArrayLike<number>): void {
  assertEquals(actual.length, expected.length);
  for (let index = 0; index < actual.length; index++) {
    if (Object.is(actual[index], expected[index])) continue;
    if (Math.abs(actual[index]! - expected[index]!) <= 1e-5) continue;
    throw new Error(
      `float mismatch at ${index}: expected ${expected[index]}, received ${actual[index]}`,
    );
  }
}

function uint8ArraysEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
