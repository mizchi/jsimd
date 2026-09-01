import type {
  ArrayIR,
  LiteralValue,
  NumberIR,
  ObjectFieldIR,
  ObjectIR,
  SchemaIR,
  StringIR,
} from "./types.ts";

export class UnsupportedSchemaError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedSchemaError";
  }
}

export function normalizeSchema(source: unknown): SchemaIR {
  if (isRecord(source) && isRecord(source["~standard"])) {
    const standard = source["~standard"];
    if (!isRecord(standard.jsonSchema) || typeof standard.jsonSchema.input !== "function") {
      throw unsupported("Standard Schema does not expose Standard JSON Schema input conversion");
    }
    assertKnownStandardSchemaSemantics(source, standard);
    const input = convertStandardJsonSchema(
      standard.jsonSchema.input as (options: { readonly target: string }) => unknown,
      "$standard.input",
    );
    const inputIR = normalizeJsonSchema(input, "$standard.input");
    if (typeof standard.jsonSchema.output !== "function") {
      throw unsupported("Standard JSON Schema does not expose output conversion");
    }
    const output = convertStandardJsonSchema(
      standard.jsonSchema.output as (options: { readonly target: string }) => unknown,
      "$standard.output",
    );
    const outputIR = normalizeJsonSchema(output, "$standard.output");
    if (JSON.stringify(inputIR) !== JSON.stringify(outputIR)) {
      throw unsupported("Standard Schema input and output differ; transforms are not supported");
    }
    return inputIR;
  }
  return normalizeJsonSchema(source, "$schema");
}

export async function normalizeSchemaAsync(source: unknown): Promise<SchemaIR> {
  if (isRecord(source) && isRecord(source["~standard"])) {
    const standard = source["~standard"];
    if (!isRecord(standard.jsonSchema) && standard.vendor === "valibot") {
      assertValibotSemantics(source, false, "$standard.valibot");
      try {
        const { toJsonSchema } = await import("@valibot/to-json-schema");
        return normalizeJsonSchema(toJsonSchema(source as never), "$standard.valibot");
      } catch (error) {
        if (error instanceof UnsupportedSchemaError) throw error;
        throw unsupported(
          `Valibot schema cannot be converted without loss: ${errorMessage(error)}`,
        );
      }
    }
  }
  return normalizeSchema(source);
}

const JSON_SCHEMA_KEYS = new Set([
  "$schema",
  "$id",
  "$comment",
  "title",
  "description",
  "deprecated",
  "readOnly",
  "writeOnly",
  "examples",
  "type",
  "const",
  "enum",
  "anyOf",
  "oneOf",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minItems",
  "maxItems",
]);

function normalizeJsonSchema(source: unknown, path: string): SchemaIR {
  if (source === true) return { kind: "any" };
  if (source === false) return { kind: "never" };
  if (!isRecord(source)) throw unsupported(`${path} must be a JSON Schema object or boolean`);
  for (const key of Object.keys(source)) {
    if (!JSON_SCHEMA_KEYS.has(key)) throw unsupported(`${path}.${key} is not supported`);
  }

  if (Object.hasOwn(source, "const")) {
    return { kind: "literal", value: literalValue(source.const, `${path}.const`) };
  }
  if (source.enum !== undefined) {
    if (!Array.isArray(source.enum)) throw unsupported(`${path}.enum must be an array`);
    if (source.enum.length === 0) return { kind: "never" };
    return {
      kind: "union",
      options: source.enum.map((value, index) => ({
        kind: "literal",
        value: literalValue(value, `${path}.enum[${index}]`),
      })),
    };
  }
  if (source.oneOf !== undefined) {
    throw unsupported(`${path}.oneOf exact-match semantics are not supported`);
  }
  if (source.anyOf !== undefined) {
    const options = source.anyOf;
    if (!Array.isArray(options) || options.length === 0) {
      throw unsupported(`${path}.anyOf/oneOf must contain at least one schema`);
    }
    return {
      kind: "union",
      options: options.map((option, index) => normalizeJsonSchema(option, `${path}[${index}]`)),
    };
  }

  if (Array.isArray(source.type)) {
    if (source.type.length === 0) return { kind: "never" };
    return {
      kind: "union",
      options: source.type.map((type, index) =>
        normalizeJsonSchema({ ...source, type }, `${path}.type[${index}]`)
      ),
    };
  }

  const type = source.type ??
    (source.properties !== undefined ? "object" : source.items !== undefined ? "array" : undefined);
  switch (type) {
    case undefined:
      return { kind: "any" };
    case "string":
      return stringIR(source, path, "code_point");
    case "number":
      return numberIR(source, path, false);
    case "integer":
      return numberIR(source, path, true);
    case "boolean":
      return { kind: "boolean" };
    case "null":
      return { kind: "null" };
    case "array": {
      const node: ArrayIR = {
        kind: "array",
        item: normalizeJsonSchema(source.items ?? true, `${path}.items`),
        ...lengthConstraints(source, path, "minItems", "maxItems"),
      };
      return node;
    }
    case "object":
      return objectIR(source, path);
    default:
      throw unsupported(`${path}.type ${JSON.stringify(type)} is not supported`);
  }
}

function objectIR(source: Record<string, unknown>, path: string): ObjectIR {
  const properties = source.properties === undefined ? {} : source.properties;
  if (!isRecord(properties)) throw unsupported(`${path}.properties must be an object`);
  const required = source.required === undefined ? [] : source.required;
  if (!Array.isArray(required) || required.some((name) => typeof name !== "string")) {
    throw unsupported(`${path}.required must be an array of strings`);
  }
  const requiredNames = new Set(required as string[]);
  const names = [...Object.keys(properties)];
  for (const name of requiredNames) if (!Object.hasOwn(properties, name)) names.push(name);
  const fields: ObjectFieldIR[] = names.map((name) => ({
    name,
    optional: !requiredNames.has(name),
    node: normalizeJsonSchema(properties[name] ?? true, `${path}.properties.${name}`),
  }));
  const additional = source.additionalProperties;
  if (additional !== undefined && additional !== true && additional !== false) {
    throw unsupported(`${path}.additionalProperties schemas are not supported`);
  }
  return {
    kind: "object",
    fields,
    unknownKeys: additional === false ? "reject" : "allow",
  };
}

function stringIR(
  source: Record<string, unknown>,
  path: string,
  lengthUnit: StringIR["lengthUnit"],
): StringIR {
  return {
    kind: "string",
    lengthUnit,
    ...lengthConstraints(source, path, "minLength", "maxLength"),
  };
}

function numberIR(
  source: Record<string, unknown>,
  path: string,
  integer: boolean,
): NumberIR {
  const minimum = optionalFinite(source.minimum, `${path}.minimum`);
  const maximum = optionalFinite(source.maximum, `${path}.maximum`);
  const exclusiveMinimum = optionalFinite(source.exclusiveMinimum, `${path}.exclusiveMinimum`);
  const exclusiveMaximum = optionalFinite(source.exclusiveMaximum, `${path}.exclusiveMaximum`);
  if (minimum !== undefined && exclusiveMinimum !== undefined) {
    throw unsupported(`${path} cannot combine minimum and exclusiveMinimum`);
  }
  if (maximum !== undefined && exclusiveMaximum !== undefined) {
    throw unsupported(`${path} cannot combine maximum and exclusiveMaximum`);
  }
  return {
    kind: "number",
    integer,
    ...(minimum !== undefined || exclusiveMinimum !== undefined
      ? { minimum: minimum ?? exclusiveMinimum }
      : {}),
    ...(maximum !== undefined || exclusiveMaximum !== undefined
      ? { maximum: maximum ?? exclusiveMaximum }
      : {}),
    exclusiveMinimum: exclusiveMinimum !== undefined,
    exclusiveMaximum: exclusiveMaximum !== undefined,
  };
}

function lengthConstraints(
  source: Record<string, unknown>,
  path: string,
  minimumKey: string,
  maximumKey: string,
): { minimumLength?: number; maximumLength?: number } {
  const minimum = optionalLength(source[minimumKey], `${path}.${minimumKey}`);
  const maximum = optionalLength(source[maximumKey], `${path}.${maximumKey}`);
  return {
    ...(minimum === undefined ? {} : { minimumLength: minimum }),
    ...(maximum === undefined ? {} : { maximumLength: maximum }),
  };
}

function literalValue(value: unknown, path: string): LiteralValue {
  if (
    value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) return value;
  throw unsupported(`${path} must be a finite JSON primitive`);
}

function optionalFinite(value: unknown, path: string): number | undefined {
  return value === undefined ? undefined : requiredFinite(value, path);
}

function requiredFinite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw unsupported(`${path} must be a finite number`);
  }
  return value;
}

function optionalLength(value: unknown, path: string): number | undefined {
  return value === undefined ? undefined : requiredLength(value, path);
}

function requiredLength(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw unsupported(`${path} must be a non-negative safe integer`);
  }
  return value as number;
}

function unsupported(message: string): UnsupportedSchemaError {
  return new UnsupportedSchemaError(message);
}

function convertStandardJsonSchema(
  convert: (options: { readonly target: string }) => unknown,
  path: string,
): unknown {
  try {
    return convert({ target: "draft-2020-12" });
  } catch (error) {
    throw unsupported(`${path} cannot be converted without loss: ${errorMessage(error)}`);
  }
}

function assertKnownStandardSchemaSemantics(
  source: Record<string, unknown>,
  standard: Record<string, unknown>,
): void {
  if (standard.vendor === "zod") assertZodSemantics(source, false, "$standard.zod");
}

const ZOD_SCHEMA_TYPES = new Set([
  "any",
  "array",
  "boolean",
  "enum",
  "literal",
  "null",
  "nullable",
  "number",
  "object",
  "optional",
  "string",
  "union",
  "unknown",
]);

const ZOD_CHECKS = new Set([
  "greater_than",
  "length_equals",
  "less_than",
  "max_length",
  "min_length",
  "number_format",
]);

function assertZodSemantics(source: unknown, optionalField: boolean, path: string): void {
  if (!isRecord(source) || !isRecord(source._zod) || !isRecord(source._zod.def)) {
    throw unsupported(`${path} is not an inspectable Zod schema`);
  }
  const definition = source._zod.def;
  const type = definition.type;
  if (typeof type !== "string" || !ZOD_SCHEMA_TYPES.has(type)) {
    throw unsupported(`${path} uses unsupported Zod schema type ${JSON.stringify(type)}`);
  }
  if (definition.coerce === true) throw unsupported(`${path} uses unsupported Zod coercion`);
  if (type === "optional" && !optionalField) {
    throw unsupported(`${path} uses optional outside an object property`);
  }
  if (Array.isArray(definition.checks)) {
    for (let index = 0; index < definition.checks.length; index++) {
      const check = definition.checks[index];
      const checkDefinition = isRecord(check) && isRecord(check._zod) && isRecord(check._zod.def)
        ? check._zod.def
        : undefined;
      if (
        checkDefinition === undefined || typeof checkDefinition.check !== "string" ||
        !ZOD_CHECKS.has(checkDefinition.check)
      ) {
        throw unsupported(
          `${path}.checks[${index}] uses unsupported Zod check ${
            JSON.stringify(checkDefinition?.check)
          }`,
        );
      }
    }
  }
  if (type === "object") {
    const shape = definition.shape;
    if (!isRecord(shape)) throw unsupported(`${path}.shape must be an object`);
    for (const [name, child] of Object.entries(shape)) {
      assertZodSemantics(child, true, `${path}.shape.${name}`);
    }
  } else if (type === "array") {
    assertZodSemantics(definition.element, false, `${path}.element`);
  } else if (type === "union") {
    if (!Array.isArray(definition.options)) throw unsupported(`${path}.options must be an array`);
    definition.options.forEach((child, index) =>
      assertZodSemantics(child, false, `${path}.options[${index}]`)
    );
  } else if (type === "nullable" || type === "optional") {
    assertZodSemantics(definition.innerType, false, `${path}.innerType`);
  }
}

function assertValibotSemantics(source: unknown, optionalField: boolean, path: string): void {
  if (!isRecord(source) || source.kind !== "schema" || typeof source.type !== "string") {
    throw unsupported(`${path} is not an inspectable Valibot schema`);
  }
  if (source.async === true) throw unsupported(`${path} uses async validation`);
  if (source.type === "object") {
    throw unsupported(`${path} uses stripping object(); use strictObject() or looseObject()`);
  }
  if (source.type === "optional" && !optionalField) {
    throw unsupported(`${path} uses optional outside an object property`);
  }
  if (source.type === "strict_object" || source.type === "loose_object") {
    if (!isRecord(source.entries)) throw unsupported(`${path}.entries must be an object`);
    for (const [name, child] of Object.entries(source.entries)) {
      assertValibotSemantics(child, true, `${path}.entries.${name}`);
    }
  } else if (source.type === "array") {
    assertValibotSemantics(source.item, false, `${path}.item`);
  } else if (source.type === "union") {
    if (!Array.isArray(source.options)) throw unsupported(`${path}.options must be an array`);
    source.options.forEach((child, index) =>
      assertValibotSemantics(child, false, `${path}.options[${index}]`)
    );
  } else if (source.type === "nullable" || source.type === "optional") {
    if (source.default !== undefined) throw unsupported(`${path} uses a default value`);
    assertValibotSemantics(source.wrapped, false, `${path}.wrapped`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
