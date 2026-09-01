import {
  array,
  boolean,
  compile,
  type InferOutput,
  integer,
  is,
  isCompiled,
  literal,
  maxLength,
  maxValue,
  minLength,
  minValue,
  nullable,
  number,
  object,
  optional,
  parse,
  pipe,
  safeParse,
  string,
  union,
  ValidationError,
} from "./scalar.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${message}: expected ${right}, got ${left}`);
}

const userSchema = object({
  name: pipe(string(), minLength(1), maxLength(16)),
  age: pipe(number(), integer(), minValue(0), maxValue(130)),
  active: boolean(),
  role: union([literal("admin"), literal("user")]),
  tags: array(string()),
  nickname: optional(nullable(string())),
});

type User = InferOutput<typeof userSchema>;

const validUser: User = {
  name: "Ada",
  age: 36,
  active: true,
  role: "admin",
  tags: ["compiler"],
};

const nullableUser: User = { ...validUser, nickname: null };

// @ts-expect-error numeric actions cannot refine a string schema
pipe(string(), integer());

Deno.test("Valibot-style combinators infer and validate object output", () => {
  assert(is(userSchema, validUser), "valid object");
  assert(!is(userSchema, { ...validUser, age: 36.5 }), "integer action");
  assert(!is(userSchema, { ...validUser, role: "owner" }), "literal union");
  assert(!is(userSchema, { ...validUser, tags: ["ok", 1] }), "array item");
  assert(is(userSchema, nullableUser), "nullable optional");
  assert(is(userSchema, { ...validUser, ignored: true }), "object permits unknown keys");
});

Deno.test("compile produces a reusable fast schema with matching behavior", () => {
  const compiled = compile(userSchema);
  const cases: readonly unknown[] = [
    validUser,
    { ...validUser, name: "" },
    { ...validUser, age: -1 },
    { ...validUser, age: 131 },
    { ...validUser, active: 1 },
    { ...validUser, tags: null },
    { ...validUser, nickname: undefined },
    null,
  ];
  for (const input of cases) {
    assertEquals(is(compiled, input), is(userSchema, input), "compiled result parity");
    assertEquals(isCompiled(compiled, input), is(userSchema, input), "compiled-only result parity");
  }
  assert(compile(compiled) === compiled, "compilation is idempotent");
});

Deno.test("compiled objects preserve semantics across specialized arities", () => {
  for (let arity = 0; arity <= 9; arity++) {
    const entries: Record<string, ReturnType<typeof string>> = {};
    const valid: Record<string, unknown> = {};
    for (let index = 0; index < arity; index++) {
      entries[`field${index}`] = string();
      valid[`field${index}`] = `value${index}`;
    }
    const schema = object(entries);
    const compiled = compile(schema);
    assert(is(compiled, valid), `arity ${arity} valid object`);
    if (arity > 0) {
      assert(!is(compiled, { ...valid, field0: 1 }), `arity ${arity} invalid field`);
      const missing = { ...valid };
      delete missing.field0;
      assert(!is(compiled, missing), `arity ${arity} missing own field`);
      const inherited = Object.assign(Object.create({ field0: "inherited" }), missing);
      assert(!is(compiled, inherited), `arity ${arity} inherited field`);
    }
  }
});

Deno.test("compiled pipes preserve repeated and nested action constraints", () => {
  const numeric = pipe(
    number(),
    minValue(-10),
    integer(),
    minValue(0),
    maxValue(20),
    maxValue(10),
  );
  const textual = pipe(
    string(),
    minLength(1),
    minLength(3),
    maxLength(8),
    maxLength(5),
  );
  for (
    const [schema, cases] of [
      [numeric, [[0, true], [10, true], [-1, false], [10.5, false], [11, false]]],
      [textual, [["abc", true], ["abcde", true], ["ab", false], ["abcdef", false]]],
    ] as const
  ) {
    const compiled = compile(schema);
    for (const [input, expected] of cases) {
      assertEquals(is(compiled, input), expected, `compiled pipe ${JSON.stringify(input)}`);
      assertEquals(is(compiled, input), is(schema, input), "compiled pipe parity");
    }
  }
});

Deno.test("a compiled optional child remains an optional object property", () => {
  const schema = object({ note: compile(optional(string())) });
  const value: InferOutput<typeof schema> = {};
  assert(is(compile(schema), value), "compiled optional field");
});

Deno.test("safeParse keeps the valid input and diagnoses only the failed path", () => {
  const compiled = compile(userSchema);
  const success = safeParse(compiled, validUser);
  assert(success.success, "safe parse success");
  assert(success.output === validUser, "validation does not clone or transform");

  const missing = safeParse(compiled, { ...validUser, name: undefined });
  assert(!missing.success, "undefined required property");
  assertEquals(missing.issues, [{
    code: "type",
    args: ["string"],
    path: ["name"],
  }], "type issue");

  const nested = safeParse(compiled, { ...validUser, tags: ["ok", 1] });
  assert(!nested.success, "nested array failure");
  assertEquals(nested.issues[0]?.path, ["tags", 1], "nested issue path");
  assertEquals(nested.issues[0]?.code, "type", "nested issue code");
});

Deno.test("missing own properties fail unless explicitly optional", () => {
  const inherited = Object.create({ name: "Ada" }) as Record<string, unknown>;
  Object.assign(inherited, {
    age: 36,
    active: true,
    role: "user",
    tags: [],
  });
  const result = safeParse(compile(userSchema), inherited);
  assert(!result.success, "inherited required property is rejected");
  assertEquals(result.issues[0]?.code, "required", "required issue");
  assertEquals(result.issues[0]?.path, ["name"], "required path");
});

Deno.test("parse throws a ValidationError with the diagnostic issue", () => {
  try {
    parse(compile(pipe(number(), integer())), 1.5);
    throw new Error("parse must throw");
  } catch (error) {
    assert(error instanceof ValidationError, "validation error class");
    assertEquals(error.message, "Validation failed", "core error does not format diagnostics");
    assertEquals(error.issues[0]?.code, "integer", "integer issue");
    assertEquals(error.issues[0]?.args, [], "argument-free issue has an empty tuple");
    assertEquals(error.issues[0]?.path, [], "root issue path");
  }
});

Deno.test("constructors reject invalid schema requirements", () => {
  for (
    const build of [
      () => minLength(-1),
      () => maxLength(1.5),
      () => minValue(Number.NaN),
      () => maxValue(Number.POSITIVE_INFINITY),
      () => union([]),
    ]
  ) {
    let threw = false;
    try {
      build();
    } catch (error) {
      threw = error instanceof RangeError;
    }
    assert(threw, "invalid schema requirement throws RangeError");
  }
});
