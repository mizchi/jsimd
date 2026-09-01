import { type } from "arktype";
import * as v from "valibot";
import * as z from "zod";
import * as zm from "zod/mini";
import {
  array,
  boolean,
  compile,
  integer,
  is,
  isCompiled,
  maxValue,
  minLength,
  minValue,
  number,
  object,
  pipe,
  safeParse,
  string,
} from "../src/scalar.ts";

export const jsimdSchema = object({
  name: pipe(string(), minLength(1)),
  age: pipe(number(), integer(), minValue(0), maxValue(130)),
  active: boolean(),
  tags: array(string()),
});
export const jsimdCompiled = compile(jsimdSchema);

const zodSchema = z.object({
  name: z.string().min(1),
  age: z.number().int().min(0).max(130),
  active: z.boolean(),
  tags: z.array(z.string()),
});
export const zodCompiled = z.compile(zodSchema, { strict: true });

const zodMiniSchema = zm.object({
  name: zm.string().check(zm.minLength(1)),
  age: zm.number().check(zm.int(), zm.minimum(0), zm.maximum(130)),
  active: zm.boolean(),
  tags: zm.array(zm.string()),
});
export const zodMiniCompiled = zm.compile(zodMiniSchema, { strict: true });

export const valibotSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1)),
  age: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(130)),
  active: v.boolean(),
  tags: v.array(v.string()),
});

export const arkSchema = type({
  name: "string >= 1",
  age: "0 <= number.integer <= 130",
  active: "boolean",
  tags: "string[]",
});

export const validInput: unknown = {
  name: "Ada",
  age: 36,
  active: true,
  tags: ["compiler", "math"],
};

export const invalidInput: unknown = {
  name: "Ada",
  age: 36.5,
  active: true,
  tags: ["compiler", 1],
};

export const booleanValidators = {
  "jsimd interpreted is": (input: unknown) => is(jsimdSchema, input),
  "jsimd internal scalar isCompiled": (input: unknown) => isCompiled(jsimdCompiled, input),
  "zod.compile safeParse": (input: unknown) => zodCompiled.safeParse(input).success,
  "zod/mini compile safeParse": (input: unknown) => zm.safeParse(zodMiniCompiled, input).success,
  "valibot is": (input: unknown) => v.is(valibotSchema, input),
  "arktype allows": (input: unknown) => arkSchema.allows(input),
} as const;

export const diagnosticValidators = {
  "jsimd internal scalar safeParse": (input: unknown) => safeParse(jsimdCompiled, input),
  "zod.compile safeParse": (input: unknown) => zodCompiled.safeParse(input),
  "zod/mini compile safeParse": (input: unknown) => zm.safeParse(zodMiniCompiled, input),
  "valibot safeParse first issue": (input: unknown) =>
    v.safeParse(valibotSchema, input, { abortEarly: true, abortPipeEarly: true }),
  "arktype invoke": (input: unknown) => arkSchema(input),
} as const;
