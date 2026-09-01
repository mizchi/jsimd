import type { AnyAction, AnySchema, InferOutput, SchemaNode } from "./types.ts";

export function is<Schema extends AnySchema>(
  schema: Schema,
  input: unknown,
): input is InferOutput<Schema> {
  const node = schema as SchemaNode;
  return node.kind === "compiled" ? node.check(input) : check(node, input);
}

export function check(schema: SchemaNode, input: unknown): boolean {
  switch (schema.kind) {
    case "string":
      return typeof input === "string";
    case "number":
      return typeof input === "number" && Number.isFinite(input);
    case "boolean":
      return typeof input === "boolean";
    case "literal":
      return Object.is(input, schema.value);
    case "array":
      if (!Array.isArray(input)) return false;
      for (const item of input) if (!check(schema.item as SchemaNode, item)) return false;
      return true;
    case "object": {
      if (!isRecord(input)) return false;
      for (const [name, child] of Object.entries(schema.entries)) {
        if (!Object.hasOwn(input, name)) {
          if (allowsMissing(child as SchemaNode)) continue;
          return false;
        }
        if (!check(child as SchemaNode, input[name])) return false;
      }
      return true;
    }
    case "union":
      for (const option of schema.options) {
        if (check(option as SchemaNode, input)) return true;
      }
      return false;
    case "optional":
      return input === undefined || check(schema.inner as SchemaNode, input);
    case "nullable":
      return input === null || check(schema.inner as SchemaNode, input);
    case "pipe":
      if (!check(schema.inner as SchemaNode, input)) return false;
      for (const action of schema.actions) if (!checkAction(action, input)) return false;
      return true;
    case "compiled":
      return schema.check(input);
  }
}

export function allowsMissing(schema: SchemaNode): boolean {
  return check(schema, undefined);
}

export function checkAction(action: AnyAction, input: unknown): boolean {
  switch (action.kind) {
    case "integer":
      return Number.isInteger(input);
    case "min_value":
      return (input as number) >= action.requirement;
    case "max_value":
      return (input as number) <= action.requirement;
    case "min_length":
      return (input as { readonly length: number }).length >= action.requirement;
    case "max_length":
      return (input as { readonly length: number }).length <= action.requirement;
  }
}

export function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

export function compiledSource(schema: SchemaNode): SchemaNode {
  return schema.kind === "compiled" ? schema.source as SchemaNode : schema;
}
