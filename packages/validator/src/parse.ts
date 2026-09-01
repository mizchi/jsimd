import { check, checkAction, compiledSource, isRecord } from "./check.ts";
import type {
  AnyAction,
  AnySchema,
  InferOutput,
  SafeParseResult,
  SchemaNode,
  ValidationIssue,
} from "./types.ts";

export class ValidationError extends TypeError {
  readonly issues: readonly [ValidationIssue];

  constructor(issues: readonly [ValidationIssue]) {
    super("Validation failed");
    this.name = "ValidationError";
    this.issues = issues;
  }
}

export function safeParse<Schema extends AnySchema>(
  schema: Schema,
  input: unknown,
): SafeParseResult<InferOutput<Schema>> {
  const node = schema as SchemaNode;
  const valid = node.kind === "compiled" ? node.check(input) : check(node, input);
  if (valid) return { success: true, output: input as InferOutput<Schema> };
  const issue = diagnose(compiledSource(node), input, []);
  if (issue === undefined) throw new Error("validator diagnostic diverged from its predicate");
  return { success: false, issues: [issue] };
}

export function parse<Schema extends AnySchema>(
  schema: Schema,
  input: unknown,
): InferOutput<Schema> {
  const result = safeParse(schema, input);
  if (result.success) return result.output;
  throw new ValidationError(result.issues);
}

function diagnose(
  schema: SchemaNode,
  input: unknown,
  path: readonly (string | number)[],
): ValidationIssue | undefined {
  switch (schema.kind) {
    case "string":
      return typeof input === "string" ? undefined : issue("type", ["string"], path);
    case "number":
      return typeof input === "number" && Number.isFinite(input)
        ? undefined
        : issue("type", ["finite number"], path);
    case "boolean":
      return typeof input === "boolean" ? undefined : issue("type", ["boolean"], path);
    case "literal":
      return Object.is(input, schema.value) ? undefined : issue("literal", [schema.value], path);
    case "array":
      if (!Array.isArray(input)) return issue("type", ["array"], path);
      for (let index = 0; index < input.length; index++) {
        const item = schema.item as SchemaNode;
        if (!check(item, input[index])) {
          return diagnose(item, input[index], [...path, index]);
        }
      }
      return undefined;
    case "object":
      if (!isRecord(input)) return issue("type", ["object"], path);
      for (const [name, child] of Object.entries(schema.entries)) {
        if (!Object.hasOwn(input, name)) {
          if (allowsUndefined(child as SchemaNode)) continue;
          return issue("required", [], [...path, name]);
        }
        const node = child as SchemaNode;
        if (!check(node, input[name])) {
          return diagnose(node, input[name], [...path, name]);
        }
      }
      return undefined;
    case "union":
      for (const option of schema.options) {
        if (check(option as SchemaNode, input)) return undefined;
      }
      return issue("union", [], path);
    case "optional":
      return input === undefined ? undefined : diagnose(schema.inner as SchemaNode, input, path);
    case "nullable":
      return input === null ? undefined : diagnose(schema.inner as SchemaNode, input, path);
    case "pipe": {
      const inner = diagnose(schema.inner as SchemaNode, input, path);
      if (inner !== undefined) return inner;
      for (const action of schema.actions) {
        if (!checkAction(action, input)) return actionIssue(action, path);
      }
      return undefined;
    }
    case "compiled":
      return diagnose(schema.source as SchemaNode, input, path);
  }
}

function allowsUndefined(schema: SchemaNode): boolean {
  return check(schema, undefined);
}

function actionIssue(
  action: AnyAction,
  path: readonly (string | number)[],
): ValidationIssue {
  switch (action.kind) {
    case "integer":
      return issue("integer", [], path);
    case "min_value":
      return issue("min_value", [action.requirement], path);
    case "max_value":
      return issue("max_value", [action.requirement], path);
    case "min_length":
      return issue("min_length", [action.requirement], path);
    case "max_length":
      return issue("max_length", [action.requirement], path);
  }
}

function issue<Code extends ValidationIssue["code"]>(
  code: Code,
  args: Extract<ValidationIssue, { readonly code: Code }>["args"],
  path: readonly (string | number)[],
): Extract<ValidationIssue, { readonly code: Code }> {
  return { code, args, path } as Extract<ValidationIssue, { readonly code: Code }>;
}
