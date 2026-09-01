import { type } from "arktype";
import * as v from "valibot";
import * as z from "zod";
import {
  array,
  boolean,
  compile,
  integer,
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
  pipe,
  safeParse,
  string,
  union,
} from "../../validator/src/scalar.ts";
import { compileSchema, type GeneratedValidatorModule } from "../src/mod.ts";

export interface AccuracyCase {
  readonly name: string;
  readonly input: unknown;
  readonly expected: boolean;
}

export interface BooleanValidator {
  readonly name: string;
  readonly item: (input: unknown) => boolean;
  readonly list: (input: unknown) => boolean;
}

export interface DiagnosticValidator {
  readonly name: string;
  readonly validate: (input: unknown) => unknown;
}

export const jsonItemSchema = {
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
  additionalProperties: true,
} as const;

const jsimdItem = object({
  name: pipe(string(), minLength(1), maxLength(16)),
  age: pipe(number(), integer(), minValue(0), maxValue(130)),
  active: boolean(),
  tags: pipe(array(string()), maxLength(4)),
  role: union([literal("admin"), literal("user")]),
  nickname: optional(nullable(string())),
});
const jsimdItemCompiled = compile(jsimdItem);
const jsimdListCompiled = compile(array(jsimdItem));

const zodItem = z.object({
  name: z.string().min(1).max(16),
  age: z.number().int().min(0).max(130),
  active: z.boolean(),
  tags: z.array(z.string()).max(4),
  role: z.enum(["admin", "user"]),
  nickname: z.string().nullable().optional(),
});
const zodItemCompiled = z.compile(zodItem, { strict: true });
const zodListCompiled = z.compile(z.array(zodItem), { strict: true });

const valibotItem = v.object({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(16)),
  age: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(130)),
  active: v.boolean(),
  tags: v.pipe(v.array(v.string()), v.maxLength(4)),
  role: v.picklist(["admin", "user"]),
  nickname: v.optional(v.nullable(v.string())),
});
const valibotList = v.array(valibotItem);

const arkName = type("string").atLeastLength(1).atMostLength(16);
const arkAge = type("number.integer").atLeast(0).atMost(130);
const arkTags = type("string[]").atMostLength(4);
const arkItem = type({
  name: arkName,
  age: arkAge,
  active: "boolean",
  tags: arkTags,
  role: "'admin' | 'user'",
  "nickname?": "string | null",
});
const arkList = arkItem.array();

const aotItem = await generated(jsonItemSchema);
const aotItemSinglePass = await generated(jsonItemSchema, { diagnosticMode: "single-pass" });
const aotList = await generated({ type: "array", items: jsonItemSchema });
const aotBooleanItem = await generated(jsonItemSchema, { target: "boolean" });
const aotBooleanList = await generated(
  { type: "array", items: jsonItemSchema },
  { target: "boolean" },
);

export const booleanValidators: readonly BooleanValidator[] = [
  {
    name: "jsimd AOT is",
    item: aotItem.is,
    list: aotList.is,
  },
  {
    name: "jsimd closure isCompiled",
    item: (input) => isCompiled(jsimdItemCompiled, input),
    list: (input) => isCompiled(jsimdListCompiled, input),
  },
  {
    name: "zod.compile safeParse",
    item: (input) => zodItemCompiled.safeParse(input).success,
    list: (input) => zodListCompiled.safeParse(input).success,
  },
  {
    name: "valibot is",
    item: (input) => v.is(valibotItem, input),
    list: (input) => v.is(valibotList, input),
  },
  {
    name: "arktype allows",
    item: (input) => arkItem.allows(input),
    list: (input) => arkList.allows(input),
  },
];

export const diagnosticValidators: readonly DiagnosticValidator[] = [
  { name: "jsimd AOT validate", validate: aotItem.validate },
  { name: "jsimd AOT single-pass", validate: aotItemSinglePass.validate },
  {
    name: "jsimd closure safeParse",
    validate: (input) => safeParse(jsimdItemCompiled, input),
  },
  { name: "zod.compile safeParse", validate: (input) => zodItemCompiled.safeParse(input) },
  {
    name: "valibot safeParse first issue",
    validate: (input) =>
      v.safeParse(valibotItem, input, { abortEarly: true, abortPipeEarly: true }),
  },
  { name: "arktype invoke", validate: (input) => arkItem(input) },
];

export const accuracyValidators: readonly BooleanValidator[] = [
  ...booleanValidators,
  {
    name: "jsimd AOT boolean-only is",
    item: aotBooleanItem.is,
    list: aotBooleanList.is,
  },
];

export const validItem = {
  name: "Ada",
  age: 36,
  active: true,
  tags: ["compiler", "math"],
  role: "admin",
  nickname: null,
};

export const earlyInvalidItem = { ...validItem, name: "" };
export const lateInvalidItem = { ...validItem, tags: ["compiler", "math", 1] };
export const validList = Array.from({ length: 128 }, (_, index) => ({
  ...validItem,
  age: index % 131,
  role: index % 2 === 0 ? "admin" : "user",
}));
export const lateInvalidList = validList.map((item, index) =>
  index === validList.length - 1 ? lateInvalidItem : item
);

export const accuracyCases: readonly AccuracyCase[] = makeAccuracyCases(100);

function makeAccuracyCases(rounds: number): AccuracyCase[] {
  const cases: AccuracyCase[] = [];
  for (let round = 0; round < rounds; round++) {
    const base = {
      ...validItem,
      name: `u${round}`,
      age: round % 131,
      active: round % 2 === 0,
      tags: Array.from({ length: round % 5 }, (_, index) => `t${index}`),
      role: round % 2 === 0 ? "admin" : "user",
      ...(round % 3 === 0 ? {} : { nickname: round % 3 === 1 ? null : `n${round}` }),
    };
    const variants: readonly [string, unknown, boolean][] = [
      ["valid", base, true],
      ["extra property", { ...base, extra: true }, true],
      ["minimum age", { ...base, age: 0 }, true],
      ["maximum age", { ...base, age: 130 }, true],
      ["maximum name", { ...base, name: "x".repeat(16) }, true],
      ["empty tags", { ...base, tags: [] }, true],
      ["empty name", { ...base, name: "" }, false],
      ["long name", { ...base, name: "x".repeat(17) }, false],
      ["negative age", { ...base, age: -1 }, false],
      ["large age", { ...base, age: 131 }, false],
      ["fractional age", { ...base, age: 0.5 }, false],
      ["string age", { ...base, age: "36" }, false],
      ["wrong active", { ...base, active: 1 }, false],
      ["non-array tags", { ...base, tags: "compiler" }, false],
      ["wrong tag", { ...base, tags: ["compiler", 1] }, false],
      ["too many tags", { ...base, tags: ["a", "b", "c", "d", "e"] }, false],
      ["wrong role", { ...base, role: "owner" }, false],
      ["wrong nickname", { ...base, nickname: 1 }, false],
      ["missing name", omit(base, "name"), false],
      ["missing age", omit(base, "age"), false],
      ["missing active", omit(base, "active"), false],
      ["missing tags", omit(base, "tags"), false],
      ["missing role", omit(base, "role"), false],
      ["null root", null, false],
      ["array root", [base], false],
    ];
    for (const [name, input, expected] of variants) {
      cases.push({ name: `${round}: ${name}`, input, expected });
    }
  }
  return cases;
}

function omit(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

async function generated(
  schema: unknown,
  options?: Parameters<typeof compileSchema>[1],
): Promise<GeneratedValidatorModule> {
  const artifact = compileSchema(schema, { backend: "javascript", ...options });
  return await import(
    `data:text/javascript,${encodeURIComponent(artifact.code)}#${crypto.randomUUID()}`
  );
}
