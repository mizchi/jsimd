import { generateValidator } from "./generate.ts";
import { generateWasmValidator } from "./generate_wasm.ts";
import { normalizeSchema, normalizeSchemaAsync } from "./normalize.ts";
import type { CompiledArtifact, CompileSchemaOptions } from "./types.ts";

export function compileSchema(
  source: unknown,
  options: CompileSchemaOptions = {},
): CompiledArtifact {
  const ir = normalizeSchema(source);
  const resolved = resolveOptions(options);
  return resolved.backend === "wasm"
    ? generateWasmValidator(ir, resolved)
    : generateValidator(ir, resolved);
}

export async function compileSchemaAsync(
  source: unknown,
  options: CompileSchemaOptions = {},
): Promise<CompiledArtifact> {
  const ir = await normalizeSchemaAsync(source);
  const resolved = resolveOptions(options);
  return resolved.backend === "wasm"
    ? generateWasmValidator(ir, resolved)
    : generateValidator(ir, resolved);
}

function resolveOptions(options: CompileSchemaOptions): CompileSchemaOptions & {
  readonly backend: "javascript" | "wasm";
} {
  const backend = options.backend ?? "wasm";
  return backend === "wasm" && options.target === undefined
    ? { ...options, backend, target: "boolean" }
    : { ...options, backend };
}

export { generateValidator } from "./generate.ts";
export { generateWasmValidator } from "./generate_wasm.ts";
export { normalizeSchema, normalizeSchemaAsync, UnsupportedSchemaError } from "./normalize.ts";
export { array, f32, f64, i16, i32, i8, strictObject, string, u16, u32, u8 } from "./schema.ts";
export type {
  CompiledArtifact,
  CompiledFiles,
  CompileSchemaOptions,
  GeneratedBooleanModule,
  GeneratedDiagnosticModule,
  GeneratedIssue,
  GeneratedIssueArguments,
  GeneratedIssueCode,
  GeneratedResult,
  GeneratedStandardIssue,
  GeneratedStandardResult,
  GeneratedValidatorModule,
  GeneratedWasmBooleanFactory,
  SchemaIR,
} from "./types.ts";
export type {
  ArrayOptions,
  ArraySchema,
  FieldSchema,
  NumericRangeOptions,
  NumericSchema,
  StrictObjectSchema,
  StringOptions,
  StringSchema,
} from "./schema.ts";
