// Internal scalar reference implementation used by accuracy and performance comparisons.
// This module is intentionally absent from the package exports and published files.
export { integer, maxLength, maxValue, minLength, minValue } from "./actions.ts";
export { is } from "./check.ts";
export { compile, isCompiled } from "./compile.ts";
export { parse, safeParse, ValidationError } from "./parse.ts";
export {
  array,
  boolean,
  literal,
  nullable,
  number,
  object,
  optional,
  pipe,
  string,
  union,
} from "./schemas.ts";
export type {
  AnySchema,
  CompiledSchema,
  InferOutput,
  IssueArguments,
  IssueCode,
  SafeParseResult,
  ValidationIssue,
} from "./types.ts";
