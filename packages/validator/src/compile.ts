import type { AnyAction, AnySchema, CompiledSchema, InferOutput, SchemaNode } from "./types.ts";

type Predicate = (input: unknown) => boolean;

interface CompiledField {
  readonly name: string;
  readonly optional: boolean;
  readonly check: Predicate;
}

export function compile<Schema extends AnySchema>(
  schema: CompiledSchema<Schema>,
): CompiledSchema<Schema>;
export function compile<Schema extends AnySchema>(schema: Schema): CompiledSchema<Schema>;
export function compile<Schema extends AnySchema>(
  schema: Schema | CompiledSchema<Schema>,
): CompiledSchema<Schema> {
  if (schema.kind === "compiled") return schema as CompiledSchema<Schema>;
  return {
    kind: "compiled",
    source: schema,
    check: compileNode(schema as SchemaNode),
  } as CompiledSchema<Schema>;
}

export function isCompiled<Schema extends AnySchema>(
  schema: CompiledSchema<Schema>,
  input: unknown,
): input is InferOutput<Schema> {
  return schema.check(input);
}

function compileNode(schema: SchemaNode): Predicate {
  switch (schema.kind) {
    case "string":
      return (input) => typeof input === "string";
    case "number":
      return (input) => typeof input === "number" && Number.isFinite(input);
    case "boolean":
      return (input) => typeof input === "boolean";
    case "literal": {
      const value = schema.value;
      return (input) => Object.is(input, value);
    }
    case "array": {
      const item = compileNode(schema.item as SchemaNode);
      return (input) => {
        if (!Array.isArray(input)) return false;
        for (let index = 0; index < input.length; index++) if (!item(input[index])) return false;
        return true;
      };
    }
    case "object": {
      const fields = Object.entries(schema.entries).map(([name, child]) => ({
        name,
        optional: allowsMissingCompiled(child as SchemaNode),
        check: compileNode(child as SchemaNode),
      }));
      return compileObject(fields);
    }
    case "union": {
      const options = schema.options.map((option) => compileNode(option as SchemaNode));
      return (input) => {
        for (let index = 0; index < options.length; index++) {
          if (options[index]!(input)) return true;
        }
        return false;
      };
    }
    case "optional": {
      const inner = compileNode(schema.inner as SchemaNode);
      return (input) => input === undefined || inner(input);
    }
    case "nullable": {
      const inner = compileNode(schema.inner as SchemaNode);
      return (input) => input === null || inner(input);
    }
    case "pipe": {
      const inner = compileNode(schema.inner as SchemaNode);
      return compilePipe(inner, schema.actions);
    }
    case "compiled":
      return schema.check;
  }
}

function allowsMissingCompiled(schema: SchemaNode): boolean {
  switch (schema.kind) {
    case "optional":
      return true;
    case "nullable":
      return allowsMissingCompiled(schema.inner as SchemaNode);
    case "union":
      return schema.options.some((option) => allowsMissingCompiled(option as SchemaNode));
    case "pipe":
      return schema.actions.length === 0 && allowsMissingCompiled(schema.inner as SchemaNode);
    case "compiled":
      return schema.check(undefined);
    default:
      return false;
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function compileObject(fields: readonly CompiledField[]): Predicate {
  switch (fields.length) {
    case 0:
      return isRecord;
    case 3: {
      const [f0, f1, f2] = fields;
      return (input) =>
        isRecord(input) && fieldMatches(input, f0!) && fieldMatches(input, f1!) &&
        fieldMatches(input, f2!);
    }
    case 4: {
      const [f0, f1, f2, f3] = fields;
      return (input) =>
        isRecord(input) && fieldMatches(input, f0!) && fieldMatches(input, f1!) &&
        fieldMatches(input, f2!) && fieldMatches(input, f3!);
    }
    case 5: {
      const [f0, f1, f2, f3, f4] = fields;
      return (input) =>
        isRecord(input) && fieldMatches(input, f0!) && fieldMatches(input, f1!) &&
        fieldMatches(input, f2!) && fieldMatches(input, f3!) && fieldMatches(input, f4!);
    }
    case 6: {
      const [f0, f1, f2, f3, f4, f5] = fields;
      return (input) =>
        isRecord(input) && fieldMatches(input, f0!) && fieldMatches(input, f1!) &&
        fieldMatches(input, f2!) && fieldMatches(input, f3!) && fieldMatches(input, f4!) &&
        fieldMatches(input, f5!);
    }
    default:
      return (input) => {
        if (!isRecord(input)) return false;
        for (let index = 0; index < fields.length; index++) {
          if (!fieldMatches(input, fields[index]!)) return false;
        }
        return true;
      };
  }
}

function fieldMatches(input: Record<string, unknown>, field: CompiledField): boolean {
  return Object.hasOwn(input, field.name) ? field.check(input[field.name]) : field.optional;
}

function compilePipe(inner: Predicate, actions: readonly AnyAction[]): Predicate {
  if (actions.every(isNumericAction)) {
    let integer = false;
    let minimum: number | undefined;
    let maximum: number | undefined;
    for (const action of actions) {
      if (action.kind === "integer") integer = true;
      if (action.kind === "min_value") {
        minimum = minimum === undefined
          ? action.requirement
          : Math.max(minimum, action.requirement);
      }
      if (action.kind === "max_value") {
        maximum = maximum === undefined
          ? action.requirement
          : Math.min(maximum, action.requirement);
      }
    }
    return (input) =>
      inner(input) && (!integer || Number.isInteger(input)) &&
      (minimum === undefined || (input as number) >= minimum) &&
      (maximum === undefined || (input as number) <= maximum);
  }

  if (actions.every(isLengthAction)) {
    let minimum: number | undefined;
    let maximum: number | undefined;
    for (const action of actions) {
      if (action.kind === "min_length") {
        minimum = minimum === undefined
          ? action.requirement
          : Math.max(minimum, action.requirement);
      }
      if (action.kind === "max_length") {
        maximum = maximum === undefined
          ? action.requirement
          : Math.min(maximum, action.requirement);
      }
    }
    return (input) =>
      inner(input) &&
      (minimum === undefined || (input as { readonly length: number }).length >= minimum) &&
      (maximum === undefined || (input as { readonly length: number }).length <= maximum);
  }

  const checks = actions.map(compileAction);
  return (input) => {
    if (!inner(input)) return false;
    for (let index = 0; index < checks.length; index++) {
      if (!checks[index]!(input)) return false;
    }
    return true;
  };
}

function isNumericAction(action: AnyAction): boolean {
  return action.kind === "integer" || action.kind === "min_value" || action.kind === "max_value";
}

function isLengthAction(action: AnyAction): boolean {
  return action.kind === "min_length" || action.kind === "max_length";
}

function compileAction(action: AnyAction): Predicate {
  switch (action.kind) {
    case "integer":
      return Number.isInteger;
    case "min_value":
      return (input) => (input as number) >= action.requirement;
    case "max_value":
      return (input) => (input as number) <= action.requirement;
    case "min_length":
      return (input) => (input as { readonly length: number }).length >= action.requirement;
    case "max_length":
      return (input) => (input as { readonly length: number }).length <= action.requirement;
  }
}
