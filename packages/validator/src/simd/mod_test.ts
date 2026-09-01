import {
  compileSimd,
  float32Array,
  float64Array,
  int32Array,
  maxValue,
  minValue,
  uint32Array,
  uint8Array,
} from "./mod.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${message}: expected ${right}, got ${left}`);
}

const unsupportedSchema = () =>
  // @ts-expect-error element actions are limited to range checks
  int32Array({ kind: "integer" });
void unsupportedSchema;

Deno.test("SIMD validates signed ranges across vector and scalar-tail boundaries", async () => {
  const validator = await compileSimd(int32Array(minValue(-10), maxValue(10)));
  for (const length of [0, 1, 3, 4, 5, 15, 16, 17, 65]) {
    const input = new Int32Array(length).fill(10);
    assert(validator.is(input), `valid length ${length}`);
    if (length === 0) continue;
    for (const index of new Set([0, Math.floor(length / 2), length - 1])) {
      input[index] = index % 2 === 0 ? -11 : 11;
      assertEquals(validator.firstInvalid(input), index, `first invalid at ${index}/${length}`);
      input[index] = 10;
    }
  }
});

Deno.test("SIMD supports unsigned 32-bit and byte boundaries", async () => {
  const u32 = await compileSimd(uint32Array(minValue(1), maxValue(0xffff_fffe)));
  const u32Input = new Uint32Array([1, 2, 0x8000_0000, 0xffff_fffe]);
  assert(u32.is(u32Input), "unsigned values including the high bit");
  u32Input[3] = 0xffff_ffff;
  assertEquals(u32.firstInvalid(u32Input), 3, "uint32 upper bound");

  const u8 = await compileSimd(uint8Array(minValue(1), maxValue(254)));
  const u8Input = new Uint8Array(33).fill(1);
  u8Input[16] = 255;
  assertEquals(u8.firstInvalid(u8Input), 16, "u8 SIMD block boundary");
});

Deno.test("fractional and impossible bounds preserve scalar comparison semantics", async () => {
  const fractional = await compileSimd(int32Array(minValue(0.5), maxValue(2.5)));
  assert(fractional.is(new Int32Array([1, 2])), "ceil/floor effective bounds");
  assertEquals(fractional.firstInvalid(new Int32Array([0, 1, 2])), 0, "fractional minimum");

  const impossible = await compileSimd(uint8Array(minValue(300)));
  assert(impossible.is(new Uint8Array()), "empty arrays satisfy every element constraint");
  assertEquals(impossible.firstInvalid(new Uint8Array([255])), 0, "out-of-domain bound");
});

Deno.test("Float32 SIMD preserves finite IEEE 754 values and rejects non-finite lanes", async () => {
  const validator = await compileSimd(float32Array());
  const finite = new Float32Array([-0, 0, 2 ** -149, -(2 ** -149), 1, -1]);
  assert(validator.is(finite), "zeroes, subnormals, and normal finite values");

  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    for (const index of [0, 3, 4]) {
      const input = new Float32Array(5).fill(1);
      input[index] = invalid;
      assertEquals(validator.firstInvalid(input), index, `first non-finite f32 at ${index}`);
    }
  }
});

Deno.test("Float32 bounds preserve JavaScript comparisons across binary32 rounding", async () => {
  const rounded = Math.fround(0.1);
  const below = previousPositiveFloat32(rounded);
  assert(rounded > 0.1, "fixture rounds upward in binary32");
  assert(below < 0.1, "fixture has an adjacent value below the requirement");

  const minimum = await compileSimd(float32Array(minValue(0.1)));
  assert(minimum.is(new Float32Array([rounded])), "rounded-up value satisfies the JS minimum");
  assertEquals(minimum.firstInvalid(new Float32Array([below])), 0, "adjacent value misses minimum");

  const maximum = await compileSimd(float32Array(maxValue(0.1)));
  assert(maximum.is(new Float32Array([below])), "adjacent value satisfies the JS maximum");
  assertEquals(
    maximum.firstInvalid(new Float32Array([rounded])),
    0,
    "rounded-up value exceeds maximum",
  );
});

Deno.test("Float64 SIMD preserves binary64 bounds and diagnoses non-finite values", async () => {
  const validator = await compileSimd(float64Array(minValue(-1), maxValue(1)));
  assert(validator.is(new Float64Array([-1, -0, Number.MIN_VALUE, 1])), "finite f64 boundaries");
  assertEquals(
    validator.firstInvalid(new Float64Array([0, 1, 1 + Number.EPSILON])),
    2,
    "binary64 upper bound",
  );

  const result = validator.safeParse(new Float64Array([0, Number.NaN]));
  assert(!result.success, "NaN fails validation");
  assertEquals(result.issues[0]?.code, "type", "NaN reports a finite-number issue");
  assertEquals(result.issues[0]?.args, ["finite number"], "NaN issue carries formatter arguments");
  assertEquals(result.issues[0]?.path, [1], "NaN issue preserves the first invalid index");
});

Deno.test("float SIMD agrees with scalar finite-range semantics", async () => {
  const float32Values = [
    0x0000_0000,
    0x8000_0000,
    0x0000_0001,
    0x8000_0001,
    0x3dcc_cccc,
    0x3dcc_cccd,
    0x3dcc_ccce,
    0x7f7f_ffff,
    0xff7f_ffff,
    0x7f80_0000,
    0xff80_0000,
    0x7fc0_0000,
  ].map(float32FromBits);
  const float32Ranges = [
    [-0.1, 0.1],
    [0.1, 0.1],
    [Number.MIN_VALUE, Number.MAX_VALUE],
    [-Number.MAX_VALUE, -Number.MIN_VALUE],
  ] as const;
  for (const [minimum, maximum] of float32Ranges) {
    const validator = await compileSimd(float32Array(minValue(minimum), maxValue(maximum)));
    for (const value of float32Values) {
      const expected = Number.isFinite(value) && value >= minimum && value <= maximum ? -1 : 0;
      assertEquals(
        validator.firstInvalid(new Float32Array([value])),
        expected,
        `f32 ${String(value)} in [${minimum}, ${maximum}]`,
      );
    }
  }

  const float64Values = [
    -Number.MAX_VALUE,
    -1,
    -Number.MIN_VALUE,
    -0,
    0,
    Number.MIN_VALUE,
    0.1,
    1,
    Number.MAX_VALUE,
    Number.NEGATIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.NaN,
  ];
  const minimum = -0.1;
  const maximum = 0.1;
  const validator = await compileSimd(float64Array(minValue(minimum), maxValue(maximum)));
  for (const value of float64Values) {
    const expected = Number.isFinite(value) && value >= minimum && value <= maximum ? -1 : 0;
    assertEquals(
      validator.firstInvalid(new Float64Array([value])),
      expected,
      `f64 ${String(value)} in [${minimum}, ${maximum}]`,
    );
  }
});

Deno.test("safeParse returns the input or the first indexed issue", async () => {
  const validator = await compileSimd(int32Array(maxValue(3), minValue(0)));
  const valid = new Int32Array([0, 1, 3]);
  const success = validator.safeParse(valid);
  assert(success.success, "success");
  assert(success.output === valid, "validation does not clone its output");

  const high = validator.safeParse(new Int32Array([0, 4, -1]));
  assert(!high.success, "high value fails");
  assertEquals(high.issues, [{
    code: "max_value",
    args: [3],
    path: [1],
  }], "first issue follows the action contract");

  const wrongType = validator.safeParse(new Uint32Array([1]));
  assert(!wrongType.success, "typed array kind is part of the contract");
  assertEquals(wrongType.issues[0]?.code, "type", "wrong typed array issue");
});

Deno.test("resident input avoids the JS-to-Wasm copy and detects stale views", async () => {
  const validator = await compileSimd(uint8Array(maxValue(9)));
  const resident = validator.resident(17);
  resident.input.fill(9);
  assert(resident.is(), "resident valid input");
  resident.input[16] = 10;
  assertEquals(resident.firstInvalid(), 16, "resident invalid index");

  validator.resident(70_000);
  let staleThrew = false;
  try {
    resident.is();
  } catch (error) {
    staleThrew = error instanceof Error && error.message.includes("stale");
  }
  assert(staleThrew, "memory growth makes an earlier resident view explicitly stale");
});

function previousPositiveFloat32(value: number): number {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setFloat32(0, value);
  view.setUint32(0, view.getUint32(0) - 1);
  return view.getFloat32(0);
}

function float32FromBits(bits: number): number {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setUint32(0, bits);
  return view.getFloat32(0);
}
