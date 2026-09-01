import type {
  AnyAction,
  AnySchema,
  ArraySchema,
  BooleanSchema,
  InferOutput,
  LiteralSchema,
  LiteralValue,
  NullableSchema,
  NumberSchema,
  ObjectEntries,
  ObjectSchema,
  OptionalSchema,
  PipeSchema,
  StringSchema,
  UnionSchema,
  ValidationAction,
} from "./types.ts";

export function string(): StringSchema {
  return { kind: "string" } as StringSchema;
}

export function number(): NumberSchema {
  return { kind: "number" } as NumberSchema;
}

export function boolean(): BooleanSchema {
  return { kind: "boolean" } as BooleanSchema;
}

export function literal<const Value extends LiteralValue>(value: Value): LiteralSchema<Value> {
  return { kind: "literal", value } as LiteralSchema<Value>;
}

export function array<const Item extends AnySchema>(item: Item): ArraySchema<Item> {
  return { kind: "array", item } as ArraySchema<Item>;
}

export function object<const Entries extends ObjectEntries>(
  entries: Entries,
): ObjectSchema<Entries> {
  return { kind: "object", entries } as ObjectSchema<Entries>;
}

export function union<const Options extends readonly AnySchema[]>(
  options: Options,
): UnionSchema<Options> {
  if (options.length === 0) throw new RangeError("union requires at least one option");
  return { kind: "union", options } as UnionSchema<Options>;
}

export function optional<const Inner extends AnySchema>(inner: Inner): OptionalSchema<Inner> {
  return { kind: "optional", inner } as OptionalSchema<Inner>;
}

export function nullable<const Inner extends AnySchema>(inner: Inner): NullableSchema<Inner> {
  return { kind: "nullable", inner } as NullableSchema<Inner>;
}

export function pipe<const Inner extends AnySchema>(
  inner: Inner,
  ...actions: readonly ValidationAction<InferOutput<Inner>>[]
): PipeSchema<Inner> {
  return { kind: "pipe", inner, actions: actions as readonly AnyAction[] } as PipeSchema<Inner>;
}
