import { generateValidator } from "./generate.ts";
import { generateWasmValidator, generateWasmValidators } from "./generate_wasm.ts";
import { normalizeSchema, normalizeSchemaAsync } from "./normalize.ts";
import type {
  CompiledArtifact,
  CompiledBatchArtifact,
  CompileSchemaOptions,
  SchemaIR,
} from "./types.ts";

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

export function compileSchemas(
  sources: Readonly<Record<string, unknown>>,
  options: CompileSchemaOptions = {},
): CompiledBatchArtifact {
  const resolved = batchOptions(options);
  return generateWasmValidators(normalizeExports(sources, normalizeSchema), resolved);
}

export async function compileSchemasAsync(
  sources: Readonly<Record<string, unknown>>,
  options: CompileSchemaOptions = {},
): Promise<CompiledBatchArtifact> {
  const resolved = batchOptions(options);
  const entries = await Promise.all(
    exportEntries(sources).map(async ([name, source]) => {
      try {
        return { name, ir: await normalizeSchemaAsync(source) };
      } catch (error) {
        throw exportError(name, error);
      }
    }),
  );
  return generateWasmValidators(entries, resolved);
}

function batchOptions(options: CompileSchemaOptions): CompileSchemaOptions & {
  readonly backend: "wasm";
  readonly target: "boolean";
} {
  const resolved = resolveOptions(options);
  if (resolved.backend !== "wasm") {
    throw new TypeError("batch compilation currently requires the Wasm backend");
  }
  if (resolved.target !== "boolean") {
    throw new TypeError('Wasm backend currently requires target: "boolean"');
  }
  return { ...resolved, backend: "wasm", target: "boolean" };
}

function normalizeExports(
  sources: Readonly<Record<string, unknown>>,
  normalize: (source: unknown) => SchemaIR,
): readonly { readonly name: string; readonly ir: SchemaIR }[] {
  return exportEntries(sources).map(([name, source]) => {
    try {
      return { name, ir: normalize(source) };
    } catch (error) {
      throw exportError(name, error);
    }
  });
}

function exportEntries(
  sources: Readonly<Record<string, unknown>>,
): readonly (readonly [string, unknown])[] {
  if (typeof sources !== "object" || sources === null || Array.isArray(sources)) {
    throw new TypeError("batch schemas must be an object of exported schemas");
  }
  const entries = Object.entries(sources);
  if (entries.length === 0) throw new TypeError("batch schemas must contain at least one export");
  if (entries.length > 256) throw new TypeError("batch schemas must contain at most 256 exports");
  return entries;
}

function exportError(name: string, error: unknown): TypeError {
  const message = error instanceof Error ? error.message : String(error);
  return new TypeError(`Export ${JSON.stringify(name)}: ${message}`, { cause: error });
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
export { generateWasmValidator, generateWasmValidators } from "./generate_wasm.ts";
export { normalizeSchema, normalizeSchemaAsync, UnsupportedSchemaError } from "./normalize.ts";
export { array, f32, f64, i16, i32, i8, strictObject, string, u16, u32, u8 } from "./schema.ts";
export type {
  CompiledArtifact,
  CompiledBatchArtifact,
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
