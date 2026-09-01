import { type } from "arktype";
import * as v from "valibot";
import * as z from "zod";
import {
  array,
  boolean,
  compile,
  integer,
  isCompiled,
  maxLength,
  maxValue,
  minLength,
  minValue,
  number,
  object,
  pipe,
  string,
} from "../../validator/src/scalar.ts";
import { compileSchema, type GeneratedBooleanModule } from "../src/mod.ts";

export interface ShapeAccuracyCase {
  readonly name: string;
  readonly input: unknown;
  readonly expected: boolean;
}

export interface ShapeValidator {
  readonly name: string;
  readonly check: (input: unknown) => boolean;
}

export interface ShapeScenario {
  readonly name: string;
  readonly valid: unknown;
  readonly earlyInvalid: unknown;
  readonly lateInvalid: unknown;
  readonly validators: readonly ShapeValidator[];
  readonly accuracyCases: readonly ShapeAccuracyCase[];
}

const stringJsonSchema = { type: "string", minLength: 4, maxLength: 32 } as const;
const jsimdString = compile(pipe(string(), minLength(4), maxLength(32)));
const zodString = z.compile(z.string().min(4).max(32), { strict: true });
const valibotString = v.pipe(v.string(), v.minLength(4), v.maxLength(32));
const arkString = type("string").atLeastLength(4).atMostLength(32);
const aotString = await generated(stringJsonSchema);

const arrayJsonSchema = {
  type: "array",
  items: { type: "integer", minimum: 0, maximum: 100 },
  minItems: 1,
  maxItems: 64,
} as const;
const jsimdArray = compile(
  pipe(array(pipe(number(), integer(), minValue(0), maxValue(100))), minLength(1), maxLength(64)),
);
const zodArray = z.compile(z.array(z.number().int().min(0).max(100)).min(1).max(64), {
  strict: true,
});
const valibotArray = v.pipe(
  v.array(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100))),
  v.minLength(1),
  v.maxLength(64),
);
const arkArray = type("number.integer").atLeast(0).atMost(100).array().atLeastLength(1)
  .atMostLength(64);
const aotArray = await generated(arrayJsonSchema);

const nestedJsonSchema = {
  type: "object",
  properties: {
    account: {
      type: "object",
      properties: {
        profile: {
          type: "object",
          properties: {
            displayName: { type: "string", minLength: 1, maxLength: 24 },
            active: { type: "boolean" },
          },
          required: ["displayName", "active"],
          additionalProperties: true,
        },
        scores: {
          type: "array",
          items: { type: "integer", minimum: 0, maximum: 100 },
          minItems: 1,
          maxItems: 8,
        },
      },
      required: ["profile", "scores"],
      additionalProperties: true,
    },
  },
  required: ["account"],
  additionalProperties: true,
} as const;
const jsimdNested = compile(object({
  account: object({
    profile: object({
      displayName: pipe(string(), minLength(1), maxLength(24)),
      active: boolean(),
    }),
    scores: pipe(
      array(pipe(number(), integer(), minValue(0), maxValue(100))),
      minLength(1),
      maxLength(8),
    ),
  }),
}));
const zodNested = z.compile(
  z.object({
    account: z.object({
      profile: z.object({
        displayName: z.string().min(1).max(24),
        active: z.boolean(),
      }),
      scores: z.array(z.number().int().min(0).max(100)).min(1).max(8),
    }),
  }),
  { strict: true },
);
const valibotNested = v.object({
  account: v.object({
    profile: v.object({
      displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(24)),
      active: v.boolean(),
    }),
    scores: v.pipe(
      v.array(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100))),
      v.minLength(1),
      v.maxLength(8),
    ),
  }),
});
const arkNested = type({
  account: type({
    profile: type({
      displayName: type("string").atLeastLength(1).atMostLength(24),
      active: "boolean",
    }),
    scores: type("number.integer").atLeast(0).atMost(100).array().atLeastLength(1).atMostLength(8),
  }),
});
const aotNested = await generated(nestedJsonSchema);

const validArray = Array.from({ length: 32 }, (_, index) => index % 101);
const earlyInvalidArray = [-1, ...validArray.slice(1)];
const lateInvalidArray = [...validArray.slice(0, -1), 101];
const validNested = {
  account: {
    profile: { displayName: "Ada", active: true },
    scores: [0, 25, 50, 75, 100],
  },
};
const earlyInvalidNested = {
  account: { ...validNested.account, profile: { displayName: "", active: true } },
};
const lateInvalidNested = {
  account: { ...validNested.account, scores: [0, 25, 50, 75, 101] },
};

export const shapeScenarios: readonly ShapeScenario[] = [
  {
    name: "bounded string",
    valid: "validator-runtime",
    earlyInvalid: 1,
    lateInvalid: "x".repeat(33),
    validators: [
      { name: "jsimd AOT is", check: aotString.is },
      { name: "jsimd closure isCompiled", check: (input) => isCompiled(jsimdString, input) },
      { name: "zod.compile safeParse", check: (input) => zodString.safeParse(input).success },
      { name: "valibot is", check: (input) => v.is(valibotString, input) },
      { name: "arktype allows", check: (input) => arkString.allows(input) },
    ],
    accuracyCases: [
      { name: "minimum", input: "abcd", expected: true },
      { name: "middle", input: "validator-runtime", expected: true },
      { name: "maximum", input: "x".repeat(32), expected: true },
      { name: "empty", input: "", expected: false },
      { name: "below minimum", input: "abc", expected: false },
      { name: "above maximum", input: "x".repeat(33), expected: false },
      { name: "number", input: 4, expected: false },
      { name: "null", input: null, expected: false },
    ],
  },
  {
    name: "bounded integer array (32)",
    valid: validArray,
    earlyInvalid: earlyInvalidArray,
    lateInvalid: lateInvalidArray,
    validators: [
      { name: "jsimd AOT is", check: aotArray.is },
      { name: "jsimd closure isCompiled", check: (input) => isCompiled(jsimdArray, input) },
      { name: "zod.compile safeParse", check: (input) => zodArray.safeParse(input).success },
      { name: "valibot is", check: (input) => v.is(valibotArray, input) },
      { name: "arktype allows", check: (input) => arkArray.allows(input) },
    ],
    accuracyCases: [
      { name: "minimum length", input: [0], expected: true },
      { name: "bounds", input: [0, 100], expected: true },
      { name: "maximum length", input: Array(64).fill(50), expected: true },
      { name: "empty", input: [], expected: false },
      { name: "below item minimum", input: [-1], expected: false },
      { name: "above item maximum", input: [101], expected: false },
      { name: "fractional item", input: [0.5], expected: false },
      { name: "wrong item type", input: ["1"], expected: false },
      { name: "above maximum length", input: Array(65).fill(50), expected: false },
      { name: "wrong root type", input: null, expected: false },
    ],
  },
  {
    name: "nested object",
    valid: validNested,
    earlyInvalid: earlyInvalidNested,
    lateInvalid: lateInvalidNested,
    validators: [
      { name: "jsimd AOT is", check: aotNested.is },
      { name: "jsimd closure isCompiled", check: (input) => isCompiled(jsimdNested, input) },
      { name: "zod.compile safeParse", check: (input) => zodNested.safeParse(input).success },
      { name: "valibot is", check: (input) => v.is(valibotNested, input) },
      { name: "arktype allows", check: (input) => arkNested.allows(input) },
    ],
    accuracyCases: [
      { name: "valid", input: validNested, expected: true },
      { name: "empty display name", input: earlyInvalidNested, expected: false },
      { name: "late score failure", input: lateInvalidNested, expected: false },
      { name: "missing account", input: {}, expected: false },
      { name: "missing profile", input: { account: { scores: [1] } }, expected: false },
      {
        name: "wrong active",
        input: { account: { profile: { displayName: "Ada", active: 1 }, scores: [1] } },
        expected: false,
      },
      {
        name: "empty scores",
        input: { account: { profile: { displayName: "Ada", active: true }, scores: [] } },
        expected: false,
      },
      { name: "wrong root type", input: [], expected: false },
    ],
  },
];

async function generated(schema: unknown): Promise<GeneratedBooleanModule> {
  const artifact = compileSchema(schema, { backend: "javascript", target: "boolean" });
  return await import(
    `data:text/javascript,${encodeURIComponent(artifact.code)}#${crypto.randomUUID()}`
  );
}
