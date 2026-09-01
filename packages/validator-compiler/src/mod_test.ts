import {
  compileSchema,
  type GeneratedValidatorModule,
  normalizeSchema,
  UnsupportedSchemaError,
} from "./mod.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  const left = JSON.stringify(canonical(actual));
  const right = JSON.stringify(canonical(expected));
  if (left !== right) throw new Error(`${message}: expected ${right}, got ${left}`);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map((
      [key, child],
    ) => [key, canonical(child)]),
  );
}

const jsonSchema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1, maxLength: 16 },
    age: { type: "integer", minimum: 0, maximum: 130 },
    active: { type: "boolean" },
    tags: { type: "array", items: { type: "string" }, maxItems: 4 },
    role: { enum: ["admin", "user"] },
    nickname: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  required: ["name", "age", "active", "tags", "role"],
  additionalProperties: false,
} as const;

Deno.test("normalizes a strict JSON Schema subset into a stable IR", () => {
  const ir = normalizeSchema(jsonSchema);
  assertEquals(ir, {
    kind: "object",
    fields: [
      {
        name: "name",
        optional: false,
        node: { kind: "string", minimumLength: 1, maximumLength: 16, lengthUnit: "code_point" },
      },
      {
        name: "age",
        optional: false,
        node: {
          kind: "number",
          integer: true,
          minimum: 0,
          maximum: 130,
          exclusiveMinimum: false,
          exclusiveMaximum: false,
        },
      },
      { name: "active", optional: false, node: { kind: "boolean" } },
      {
        name: "tags",
        optional: false,
        node: {
          kind: "array",
          item: { kind: "string", lengthUnit: "code_point" },
          maximumLength: 4,
        },
      },
      {
        name: "role",
        optional: false,
        node: {
          kind: "union",
          options: [
            { kind: "literal", value: "admin" },
            { kind: "literal", value: "user" },
          ],
        },
      },
      {
        name: "nickname",
        optional: true,
        node: {
          kind: "union",
          options: [{ kind: "string", lengthUnit: "code_point" }, { kind: "null" }],
        },
      },
    ],
    unknownKeys: "reject",
  }, "normalized IR");
});

Deno.test("uses Standard JSON Schema input conversion without calling validate", () => {
  let validateCalls = 0;
  let target: string | undefined;
  const standard = {
    "~standard": {
      version: 1 as const,
      vendor: "fixture",
      validate: (_input: unknown) => {
        validateCalls++;
        return { value: _input };
      },
      jsonSchema: {
        input: (options: { target: string }) => {
          target = options.target;
          return { type: "string", minLength: 2 };
        },
        output: () => ({ type: "string", minLength: 2 }),
      },
    },
  };
  assertEquals(normalizeSchema(standard), {
    kind: "string",
    minimumLength: 2,
    lengthUnit: "code_point",
  }, "standard JSON schema IR");
  assertEquals(target, "draft-2020-12", "conversion target");
  assertEquals(validateCalls, 0, "source validator is build-time metadata only");
});

Deno.test("rejects opaque Standard Schema and unsupported validation keywords", () => {
  const opaque = {
    "~standard": {
      version: 1 as const,
      vendor: "opaque",
      validate: (value: unknown) => ({ value }),
    },
  };
  for (
    const source of [
      opaque,
      { kind: "string" },
      { type: "string", pattern: "^[a-z]+$" },
      { type: "string", default: "fallback" },
      { oneOf: [{ type: "number" }, { type: "integer" }] },
    ]
  ) {
    let found: unknown;
    try {
      normalizeSchema(source);
    } catch (error) {
      found = error;
    }
    assert(found instanceof UnsupportedSchemaError, "unsupported source must fail explicitly");
  }
});

Deno.test("generates a dependency-free Standard Schema validator with first issues", async () => {
  const artifact = compileSchema(jsonSchema, { backend: "javascript" });
  assertEquals(artifact.backend, "javascript", "explicit JavaScript backend");
  assertEquals(artifact.files, {
    javascript: artifact.code,
    typescript: artifact.declaration,
  }, "compile returns paired JavaScript and TypeScript artifacts");
  assert(!artifact.code.includes("import "), "generated runtime has no imports");
  assert(!artifact.code.includes("new Function"), "generated runtime does not JIT");
  assert(!artifact.code.includes("JSON.parse"), "JSON parser is opt-in");
  assert(artifact.declaration.includes("export interface Output"), "output declaration");
  assert(artifact.declaration.includes("readonly types?"), "Standard Schema phantom types");
  assert(
    artifact.declaration.includes(
      "readonly validate: (input: unknown) => StandardValidationResult",
    ),
    "Standard Schema validate is emitted as a readonly function property",
  );
  assert(
    artifact.code.includes("const length=codePoints(value)"),
    "bounded code-point length is computed once per predicate",
  );
  assert(
    !artifact.code.match(/const c\d+=value=>[^;]*Number\.isFinite\(value\)[^;]*Number\.isInteger/),
    "integer predicates do not repeat the finite-number check",
  );
  assert(
    artifact.code.includes('value==="admin"||value==="user"'),
    "primitive literal unions are fused",
  );

  const generated = await importArtifact(artifact.code);
  const valid = {
    name: "Ada",
    age: 36,
    active: true,
    tags: ["compiler"],
    role: "admin",
    nickname: null,
  };
  assert(generated.is(valid), "generated predicate accepts valid input");
  assert(!generated.is({ ...valid, age: 36.5 }), "integer constraint");
  assert(!generated.is({ ...valid, extra: true }), "strict unknown key contract");

  const success = generated.schema["~standard"].validate(valid);
  assertEquals(success, { value: valid }, "standard success");

  const rawNested = generated.validate({ ...valid, tags: ["ok", 1] });
  assertEquals(rawNested, {
    issues: [{ code: "type", args: ["string"], path: ["tags", 1] }],
  }, "raw AOT issue");

  const nested = generated.schema["~standard"].validate({ ...valid, tags: ["ok", 1] });
  assertEquals(nested, {
    issues: [{ message: "Expected string", path: ["tags", 1] }],
  }, "first nested issue");

  const missing = generated.schema["~standard"].validate({ ...valid, name: undefined });
  assertEquals(missing, {
    issues: [{ message: "Expected string", path: ["name"] }],
  }, "present undefined is a type issue");
});

Deno.test("optionally emits native JSON parse plus AOT validation", async () => {
  const artifact = compileSchema(jsonSchema, {
    backend: "javascript",
    jsonParser: "native",
  });
  assert(artifact.code.includes("JSON.parse"), "native parser emitted");
  const generated = await importArtifact(artifact.code);
  assert(typeof generated.parseJSON === "function", "parseJSON export");

  const success = generated.parseJSON!(
    '{"name":"Ada","age":36,"active":true,"tags":[],"role":"user"}',
  );
  assert("value" in success, "JSON parse success");
  assertEquals(success.value, {
    name: "Ada",
    age: 36,
    active: true,
    tags: [],
    role: "user",
  }, "parsed output");

  assertEquals(generated.parseJSON!("{"), {
    issues: [{ code: "invalid_json", args: [], path: [] }],
  }, "syntax issue");
  assertEquals(
    generated.parseJSON!(
      '{"name":"Ada","age":999,"active":true,"tags":[],"role":"user"}',
    ),
    {
      issues: [{ code: "max_value", args: [130], path: ["age"] }],
    },
    "validation issue after parse",
  );
});

Deno.test("preserves JSON Schema code-point lengths and exclusive bounds", async () => {
  const artifact = compileSchema({
    type: "object",
    properties: {
      glyph: { type: "string", minLength: 1, maxLength: 1 },
      ratio: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
    },
    required: ["glyph", "ratio"],
    additionalProperties: false,
  }, { backend: "javascript" });
  const generated = await importArtifact(artifact.code);

  assert(
    artifact.code.includes("/[\\uD800-\\uDFFF]/.test(value)?[...value].length:value.length"),
    "generated code uses an ASCII-fast code-point counter",
  );

  assert(generated.is({ glyph: "😀", ratio: 0.5 }), "astral symbol is one JSON Schema code point");
  assert(generated.is({ glyph: "\uD800", ratio: 0.5 }), "unpaired surrogate is one code point");
  assert(
    !generated.is({ glyph: "\uD800a", ratio: 0.5 }),
    "unpaired surrogate plus ASCII is two code points",
  );
  assert(!generated.is({ glyph: "ab", ratio: 0.5 }), "two code points exceed maxLength");
  assert(!generated.is({ glyph: "a", ratio: 0 }), "exclusive minimum rejects its boundary");
  assert(!generated.is({ glyph: "a", ratio: 1 }), "exclusive maximum rejects its boundary");
});

Deno.test("optionally emits single-pass first-issue diagnostics", async () => {
  const artifact = compileSchema(jsonSchema, {
    backend: "javascript",
    diagnosticMode: "single-pass",
  });
  assert(
    artifact.code.includes("const found=d0(value,[])") &&
      !artifact.code.includes("c0(value)?{value}"),
    "single-pass validate starts with the diagnostic traversal",
  );
  const generated = await importArtifact(artifact.code);
  const valid = { name: "Ada", age: 36, active: true, tags: [], role: "user" };
  assertEquals(generated.validate(valid), { value: valid }, "single-pass valid result");
  assertEquals(generated.validate({ ...valid, tags: [1] }), {
    issues: [{ code: "type", args: ["string"], path: ["tags", 0] }],
  }, "single-pass invalid result");

  const rootCases = [
    [{ type: "boolean" }, true, 1],
    [{ type: "null" }, null, false],
    [{ const: "ready" }, "ready", "waiting"],
    [{ anyOf: [{ type: "string" }, { type: "boolean" }] }, true, 1],
  ] as const;
  for (const [schema, accepted, rejected] of rootCases) {
    const root = await importArtifact(
      compileSchema(schema, {
        backend: "javascript",
        diagnosticMode: "single-pass",
      }).code,
    );
    assertEquals(root.validate(accepted), { value: accepted }, "single-pass root valid result");
    assert("issues" in root.validate(rejected), "single-pass root invalid result");
  }
});

Deno.test("optionally emits raw diagnostics without a formatting adapter", async () => {
  const artifact = compileSchema(jsonSchema, {
    backend: "javascript",
    target: "diagnostic",
  });
  assert(!artifact.code.includes("standardMessage"), "raw target omits formatter");
  assert(!artifact.code.includes('"~standard"'), "raw target omits Standard Schema adapter");
  assert(
    !artifact.declaration.includes("StandardValidationResult"),
    "raw declaration omits adapter",
  );

  const generated = await importArtifact(artifact.code);
  const valid = { name: "Ada", age: 36, active: true, tags: [], role: "user" };
  assertEquals(generated.validate({ ...valid, age: 131 }), {
    issues: [{ code: "max_value", args: [130], path: ["age"] }],
  }, "raw diagnostic result");
});

Deno.test("optionally emits a boolean-only AOT module", async () => {
  const artifact = compileSchema(jsonSchema, {
    backend: "javascript",
    target: "boolean",
  });
  assert(!artifact.code.includes("const issue="), "boolean target omits issue runtime");
  assert(!artifact.code.includes("validate"), "boolean target omits diagnostic exports");
  assert(!artifact.code.includes('"~standard"'), "boolean target omits Standard Schema wrapper");
  assert(
    !artifact.code.includes('Object.is(value,"admin")'),
    "boolean target omits predicates already inlined into a union",
  );
  const generated = await importArtifact(artifact.code);
  const valid = { name: "Ada", age: 36, active: true, tags: [], role: "user" };
  assert(generated.is(valid), "boolean target accepts valid input");
  assert(!generated.is({ ...valid, age: 131 }), "boolean target rejects invalid input");
  assert(!artifact.declaration.includes("validate"), "boolean declaration exposes only is");

  const gzip = await new Response(
    new Blob([artifact.code]).stream().pipeThrough(new CompressionStream("gzip")),
  ).bytes();
  assert(gzip.byteLength <= 540, `boolean-only gzip budget: ${gzip.byteLength}`);

  for (
    const options of [
      { target: "boolean", jsonParser: "native" },
      { target: "boolean", diagnosticMode: "single-pass" },
    ] as const
  ) {
    let rejected = false;
    try {
      compileSchema(jsonSchema, { backend: "javascript", ...options });
    } catch (error) {
      rejected = error instanceof TypeError;
    }
    assert(rejected, "boolean target rejects diagnostic-only options");
  }
});

Deno.test("generated artifacts stay within a prototype gzip budget", async () => {
  const artifact = compileSchema(jsonSchema, {
    backend: "javascript",
    jsonParser: "native",
  });
  const bytes = new TextEncoder().encode(artifact.code);
  const gzip = await new Response(
    new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")),
  ).bytes();
  assert(gzip.byteLength <= 2_500, `generated gzip budget: ${gzip.byteLength}`);
});

Deno.test("uses an ordered-key fast path for very wide JavaScript strict objects", async () => {
  const properties = Object.fromEntries(
    Array.from({ length: 128 }, (_, index) => [
      `value${index}`,
      { type: "number", minimum: index, maximum: index + 100 },
    ]),
  );
  const required = Object.keys(properties).slice(0, -1);
  const schema = {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
  const artifact = compileSchema(schema, { backend: "javascript", target: "boolean" });
  assert(
    artifact.code.includes("new Set(expectedKeys0)") &&
      !artifact.code.includes('key!=="value127"'),
    "very wide strict objects use ordered keys with a Set fallback",
  );
  const generated = await importArtifact(artifact.code) as unknown as {
    is(input: unknown): boolean;
  };
  const valid = Object.fromEntries(
    Array.from({ length: 128 }, (_, index) => [`value${index}`, index + 50]),
  );
  assert(generated.is(valid), "schema-order records use the fast path");
  assert(
    generated.is(Object.fromEntries(Object.entries(valid).reverse())),
    "reordered records use the fallback",
  );
  const withoutOptional = { ...valid };
  delete withoutOptional.value127;
  assert(generated.is(withoutOptional), "omitted optional properties remain valid");
  assert(!generated.is({ ...valid, extra: 1 }), "additional properties are rejected");
  const sameCountUnknown = { ...withoutOptional, extra: 1 };
  assert(!generated.is(sameCountUnknown), "same-count unknown properties are rejected");
  const nonEnumerable = { ...valid };
  Object.defineProperty(nonEnumerable, "value0", { enumerable: false, value: 50 });
  assert(generated.is(nonEnumerable), "non-enumerable required own properties remain valid");
  const { value0: _inherited, ...withoutValue0 } = valid;
  const inherited = Object.assign(Object.create({ value0: 50 }), withoutValue0);
  assert(!generated.is(inherited), "inherited properties do not satisfy required fields");

  const diagnosticArtifact = compileSchema(schema, {
    backend: "javascript",
    target: "diagnostic",
  });
  const diagnostic = await importArtifact(diagnosticArtifact.code) as unknown as {
    validate(input: unknown): { issues?: readonly { code: string; path: readonly string[] }[] };
  };
  assertEquals(
    diagnostic.validate({ ...valid, extra: 1 }).issues?.[0],
    { code: "unknown_key", args: [], path: ["extra"] },
    "diagnostic fallback reports the unknown key",
  );

  const narrowProperties = Object.fromEntries(Object.entries(properties).slice(0, 64));
  const narrow = compileSchema({
    type: "object",
    properties: narrowProperties,
    required: Object.keys(narrowProperties),
    additionalProperties: false,
  }, { backend: "javascript", target: "boolean" });
  assert(!narrow.code.includes("new Set(expectedKeys0)"), "narrow objects keep compact checks");
});

Deno.test("generates a schema-specialized Wasm SIMD predicate for wide numeric objects", async () => {
  const properties = Object.fromEntries(
    Array.from({ length: 64 }, (_, index) => [
      `value${index}`,
      {
        type: "number",
        minimum: index,
        maximum: index + 100,
      },
    ]),
  );
  const artifact = compileSchema({
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  });

  assertEquals(artifact.backend, "wasm", "default Wasm backend");
  assert(artifact.files.wasm instanceof Uint8Array, "Wasm backend emits a binary module");
  assert(
    WebAssembly.validate(artifact.files.wasm as Uint8Array<ArrayBuffer>),
    "generated Wasm binary validates",
  );
  assert(
    artifact.code.includes("export const instantiate="),
    "generated JavaScript is explicit instantiation glue",
  );
  assert(
    artifact.code.includes("new Set(expected)") && !artifact.code.includes("switch(key)"),
    "wide strict objects use an ordered-key fast path with a Set fallback",
  );

  const generated = await importArtifact(artifact.code) as unknown as {
    instantiate(source: Uint8Array): { is(input: unknown): boolean };
  };
  const validator = generated.instantiate(artifact.files.wasm);
  const valid = Object.fromEntries(
    Array.from({ length: 64 }, (_, index) => [`value${index}`, index + 50]),
  );
  assert(validator.is(valid), "Wasm predicate accepts a valid object");
  assert(
    validator.is(Object.fromEntries(Object.entries(valid).reverse())),
    "different property order falls back without changing validity",
  );
  for (let index = 0; index < 64; index++) {
    assert(
      !validator.is({ ...valid, [`value${index}`]: index - 1 }),
      `lane ${index} minimum is enforced`,
    );
    assert(
      !validator.is({ ...valid, [`value${index}`]: index + 101 }),
      `lane ${index} maximum is enforced`,
    );
  }
  assert(!validator.is({ ...valid, value3: Number.NaN }), "NaN is rejected");
  assert(!validator.is({ ...valid, value3: Number.POSITIVE_INFINITY }), "infinity is rejected");
  assert(!validator.is({ ...valid, value3: "3" }), "non-number is rejected before Wasm");
  assert(
    !validator.is({ ...valid, value0: Symbol("not a number") }),
    "preflight rejects symbols without coercing them",
  );
  const earlyInvalidWithoutShapeScan = new Proxy({ ...valid, value0: -1 }, {
    ownKeys() {
      throw new Error("strict shape scan must not run after a known-field failure");
    },
  });
  assert(
    !validator.is(earlyInvalidWithoutShapeScan),
    "known-field failures short-circuit before strict shape enumeration",
  );
  const { value63: _missing, ...missing } = valid;
  assert(!validator.is(missing), "required own properties are enforced");
  assert(!validator.is({ ...valid, extra: 1 }), "unknown properties are rejected");
  const sameCountUnknown = { ...valid };
  delete sameCountUnknown.value63;
  (sameCountUnknown as Record<string, unknown>).extra = 1;
  assert(!validator.is(sameCountUnknown), "same-count unknown properties are rejected by fallback");
  const nonEnumerable = { ...valid };
  Object.defineProperty(nonEnumerable, "value0", { enumerable: false, value: 50 });
  assert(
    validator.is(nonEnumerable),
    "non-enumerable required own properties preserve JS AOT semantics",
  );
  const { value0: _inherited, ...withoutValue0 } = valid;
  const inherited = Object.assign(Object.create({ value0: 50 }), withoutValue0);
  assert(!validator.is(inherited), "inherited properties do not satisfy required fields");

  const mediumProperties = Object.fromEntries(
    Array.from({ length: 32 }, (_, index) => [
      `value${index}`,
      { type: "number", minimum: index, maximum: index + 100 },
    ]),
  );
  const mediumArtifact = compileSchema({
    type: "object",
    properties: mediumProperties,
    required: Object.keys(mediumProperties),
    additionalProperties: false,
  }, { backend: "wasm", target: "boolean" });
  assert(
    mediumArtifact.code.includes("new Set(expected)") &&
      !mediumArtifact.code.includes("switch(key)"),
    "medium strict objects use the ordered-key fast path",
  );

  const mixedArtifact = compileSchema({
    type: "object",
    properties: {
      open: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
      closed: { type: "number", minimum: 0, maximum: 1 },
      finite: { type: "number" },
      value3: { type: "number" },
      value4: { type: "number" },
      value5: { type: "number" },
      value6: { type: "number" },
      value7: { type: "number" },
    },
    required: ["open", "closed", "finite", "value3", "value4", "value5", "value6", "value7"],
    additionalProperties: false,
  }, { backend: "wasm", target: "boolean" });
  assert(
    mixedArtifact.code.includes("switch(key)") &&
      !mixedArtifact.code.includes("new Set(expected)"),
    "narrow strict objects keep the smaller switch shape check",
  );
  const mixedFactory = await importArtifact(mixedArtifact.code) as unknown as {
    instantiate(source: Uint8Array): { is(input: unknown): boolean };
  };
  const mixed = mixedFactory.instantiate(mixedArtifact.files.wasm!);
  const mixedValid = {
    open: 0.5,
    closed: 0,
    finite: 1,
    value3: 3,
    value4: 4,
    value5: 5,
    value6: 6,
    value7: 7,
  };
  assert(mixed.is(mixedValid), "mixed lanes pass");
  assert(!mixed.is({ ...mixedValid, open: 0 }), "exclusive lower bound fails");
  assert(!mixed.is({ ...mixedValid, closed: 1.1 }), "inclusive upper bound fails");

  let defaultUnsupported: unknown;
  try {
    compileSchema({ type: "string" });
  } catch (error) {
    defaultUnsupported = error;
  }
  assert(
    defaultUnsupported instanceof TypeError,
    "the default backend rejects unsupported schemas instead of falling back to JavaScript",
  );

  for (
    const [schema, options] of [
      [{ type: "string" }, { backend: "wasm", target: "boolean" }],
      [
        {
          type: "array",
          items: { type: "number", minimum: -1, maximum: 1 },
          minItems: 64,
          maxItems: 64,
        },
        { backend: "wasm", target: "boolean" },
      ],
      [
        {
          type: "object",
          properties: { count: { type: "integer" }, total: { type: "number" } },
          required: ["count", "total"],
        },
        { backend: "wasm", target: "boolean" },
      ],
      [
        {
          type: "object",
          properties: { left: { type: "number" }, right: { type: "number" } },
          required: ["left", "right"],
        },
        { backend: "wasm" },
      ],
    ] as const
  ) {
    let found: unknown;
    try {
      compileSchema(schema, options);
    } catch (error) {
      found = error;
    }
    assert(found instanceof TypeError, "unsupported Wasm backend input fails at compile time");
  }

  let incompatible: unknown;
  try {
    compileSchema({
      type: "object",
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    }, { backend: "wasm", target: "boolean", jsonParser: "native" });
  } catch (error) {
    incompatible = error;
  }
  assert(incompatible instanceof TypeError, "Wasm backend rejects parser options");
});

async function importArtifact(code: string): Promise<GeneratedValidatorModule> {
  return await import(`data:text/javascript,${encodeURIComponent(code)}#${crypto.randomUUID()}`);
}
