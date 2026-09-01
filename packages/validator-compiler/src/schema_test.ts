import {
  array,
  compileSchema,
  f32,
  f64,
  i16,
  i32,
  i8,
  strictObject,
  string,
  u16,
  u32,
  u8,
} from "./mod.ts";

Deno.test("nested objects and bounded arrays compile static numeric leaves to Wasm", async () => {
  const schema = strictObject({
    header: strictObject({
      kind: u8(),
      flags: u8(),
      width: u16(),
      height: u16(),
    }),
    samples: array(i16({ min: -1_000, max: 1_000 }), { minLength: 4, maxLength: 4 }),
    tail: array(u8(), { maxLength: 3 }),
    tags: array(string({ maxLength: 4 }), { maxLength: 2 }),
  });
  const artifact = compileSchema(schema);
  const factory = await import(
    `data:text/javascript,${encodeURIComponent(artifact.files.javascript)}#${crypto.randomUUID()}`
  ) as {
    instantiate(source: Uint8Array): { is(input: unknown): boolean };
  };
  const validator = factory.instantiate(artifact.files.wasm!);
  const valid = {
    header: { kind: 1, flags: 2, width: 640, height: 480 },
    samples: [-1_000, 0, 1, 1_000],
    tail: [0, 255],
    tags: ["ok", "😀😀😀😀"],
  };

  assert(validator.is(valid));
  assert(!validator.is({ ...valid, header: { ...valid.header, extra: 1 } }));
  assert(!validator.is({ ...valid, header: { ...valid.header, width: 65_536 } }));
  assert(!validator.is({ ...valid, samples: [-1_000, 0, 0.5, 1_000] }));
  assert(!validator.is({ ...valid, samples: [-1_001, 0, 1, 1_000] }));
  assert(!validator.is({ ...valid, samples: [0, 1, 2] }));
  assert(!validator.is({ ...valid, tail: [0, 1.5] }));
  assert(!validator.is({ ...valid, tail: [256] }));
  assert(!validator.is({ ...valid, tags: ["a", "b", "c"] }));
  assert(!validator.is({ ...valid, tags: ["abcde"] }));
  assert(
    artifact.files.typescript.includes(
      'readonly "samples": readonly (number)[];',
    ) && artifact.files.typescript.includes('readonly "header": {'),
    "nested and array declarations are generated",
  );
});

Deno.test("numeric and bounded-string helpers build a strict Wasm-compilable schema", async () => {
  const schema = strictObject({
    byte: u8({ min: 1, max: 200 }),
    word: u16(),
    unsigned: u32(),
    signedByte: i8(),
    signedWord: i16(),
    signed: i32(),
    single: f32({ min: -1, max: 1 }),
    double: f64({ min: -10, max: 10 }),
    label: string({ minLength: 1, maxLength: 3 }),
  });

  assertEquals(schema, {
    type: "object",
    properties: {
      byte: { type: "integer", minimum: 1, maximum: 200 },
      word: { type: "integer", minimum: 0, maximum: 65_535 },
      unsigned: { type: "integer", minimum: 0, maximum: 4_294_967_295 },
      signedByte: { type: "integer", minimum: -128, maximum: 127 },
      signedWord: { type: "integer", minimum: -32_768, maximum: 32_767 },
      signed: { type: "integer", minimum: -2_147_483_648, maximum: 2_147_483_647 },
      single: { type: "number", minimum: -1, maximum: 1 },
      double: { type: "number", minimum: -10, maximum: 10 },
      label: { type: "string", minLength: 1, maxLength: 3 },
    },
    required: [
      "byte",
      "word",
      "unsigned",
      "signedByte",
      "signedWord",
      "signed",
      "single",
      "double",
      "label",
    ],
    additionalProperties: false,
  });

  const artifact = compileSchema(schema);
  assertEquals(artifact.backend, "wasm");
  assert(
    artifact.files.typescript.includes('readonly "byte": number;') &&
      artifact.files.typescript.includes('readonly "single": number;') &&
      artifact.files.typescript.includes('readonly "label": string;'),
    "generated TypeScript fields match their JavaScript scalar types",
  );
  const factory = await import(
    `data:text/javascript,${encodeURIComponent(artifact.files.javascript)}#${crypto.randomUUID()}`
  ) as {
    instantiate(source: Uint8Array): { is(input: unknown): boolean };
  };
  const validator = factory.instantiate(artifact.files.wasm!);
  const valid = {
    byte: 200,
    word: 65_535,
    unsigned: 4_294_967_295,
    signedByte: -128,
    signedWord: 32_767,
    signed: -2_147_483_648,
    single: 0.5,
    double: 1 / 3,
    label: "abc",
  };
  assert(validator.is(valid));
  assert(!validator.is({ ...valid, byte: 200.5 }), "integer helper rejects fractions");
  assert(!validator.is({ ...valid, byte: 201 }), "custom maximum is enforced");
  assert(!validator.is({ ...valid, signedByte: -129 }), "intrinsic minimum is enforced");
  assert(!validator.is({ ...valid, single: Number.NaN }), "floating helpers reject NaN");
  assert(!validator.is({ ...valid, double: Number.POSITIVE_INFINITY }), "f64 rejects infinity");
  assert(validator.is({ ...valid, label: "😀ab" }), "string length counts Unicode code points");
  assert(!validator.is({ ...valid, label: "😀abc" }), "string maximum is enforced");
  assert(!validator.is({ ...valid, label: "" }), "string minimum is enforced");
  assert(!validator.is({ ...valid, label: 1 }), "string type is enforced");
  assert(!validator.is({ ...valid, extra: 0 }), "strictObject rejects unknown fields");
});

Deno.test("schema helpers reject invalid or unsupported options", () => {
  assertThrows(() => u8({ min: -1 }), "u8 min must be between 0 and 255");
  assertThrows(() => u16({ max: 1.5 }), "u16 max must be an integer");
  assertThrows(() => i32({ min: 2, max: 1 }), "i32 min must not exceed max");
  assertThrows(() => f32({ min: Number.NaN }), "f32 min must be finite");
  assertThrows(
    () => f32({ max: Number.MAX_VALUE }),
    "f32 max must be between",
  );
  assertThrows(
    () => u8({ min: 0, precision: 8 } as never),
    "u8 option precision is not supported",
  );
  assertThrows(() => string({} as never), "string maxLength is required");
  assertThrows(() => string({ maxLength: -1 }), "string maxLength must be a non-negative integer");
  assertThrows(
    () => string({ minLength: 2, maxLength: 1 }),
    "string minLength must not exceed maxLength",
  );
  assertThrows(
    () => string({ maxLength: 1, encoding: "utf8" } as never),
    "string option encoding is not supported",
  );
  assertThrows(() => array(u8(), {} as never), "array maxLength is required");
  assertThrows(
    () => array(u8(), { maxLength: -1 }),
    "array maxLength must be a non-negative integer",
  );
  assertThrows(
    () => array(u8(), { minLength: 2, maxLength: 1 }),
    "array minLength must not exceed maxLength",
  );
});

Deno.test("Wasm bounded strings require a numeric SIMD workload and an upper bound", () => {
  const strings = Object.fromEntries(
    Array.from({ length: 8 }, (_, index) => [`text${index}`, string({ maxLength: 8 })]),
  );
  assertThrows(
    () => compileSchema(strictObject(strings)),
    "Wasm object backend requires 8 to 256 static numeric leaves",
  );

  const numbers = Object.fromEntries(
    Array.from({ length: 8 }, (_, index) => [`value${index}`, u8()]),
  );
  assertThrows(
    () =>
      compileSchema({
        type: "object",
        properties: { ...numbers, text: { type: "string" } },
        required: [...Object.keys(numbers), "text"],
        additionalProperties: false,
      }),
    "bounded-string field",
  );
  assertThrows(
    () =>
      compileSchema({
        type: "object",
        properties: { ...numbers, values: { type: "array", items: { type: "number" } } },
        required: [...Object.keys(numbers), "values"],
        additionalProperties: false,
      }),
    "bounded array with maxItems",
  );
});

function assert(condition: unknown, message = "expected condition to be true"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) throw new Error(`expected ${expectedJson}, got ${actualJson}`);
}

function assertThrows(action: () => unknown, message: string): void {
  try {
    action();
  } catch (error) {
    if (error instanceof TypeError && error.message.includes(message)) return;
    throw error;
  }
  throw new Error(`expected TypeError containing ${JSON.stringify(message)}`);
}
