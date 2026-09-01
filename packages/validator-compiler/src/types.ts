export type SchemaIR =
  | AnyIR
  | NeverIR
  | StringIR
  | NumberIR
  | BooleanIR
  | NullIR
  | LiteralIR
  | ArrayIR
  | ObjectIR
  | UnionIR;

export interface AnyIR {
  readonly kind: "any";
}

export interface NeverIR {
  readonly kind: "never";
}

export interface StringIR {
  readonly kind: "string";
  readonly lengthUnit: "code_unit" | "code_point";
  readonly minimumLength?: number;
  readonly maximumLength?: number;
}

export interface NumberIR {
  readonly kind: "number";
  readonly integer: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum: boolean;
  readonly exclusiveMaximum: boolean;
}

export interface BooleanIR {
  readonly kind: "boolean";
}

export interface NullIR {
  readonly kind: "null";
}

export type LiteralValue = string | number | boolean | null;

export interface LiteralIR {
  readonly kind: "literal";
  readonly value: LiteralValue;
}

export interface ArrayIR {
  readonly kind: "array";
  readonly item: SchemaIR;
  readonly minimumLength?: number;
  readonly maximumLength?: number;
}

export interface ObjectFieldIR {
  readonly name: string;
  readonly optional: boolean;
  readonly node: SchemaIR;
}

export interface ObjectIR {
  readonly kind: "object";
  readonly fields: readonly ObjectFieldIR[];
  readonly unknownKeys: "allow" | "reject";
}

export interface UnionIR {
  readonly kind: "union";
  readonly options: readonly SchemaIR[];
}

export interface CompileSchemaOptions {
  /** Defaults to the schema-specialized Wasm SIMD backend. */
  readonly backend?: "javascript" | "wasm";
  readonly target?: "standard" | "diagnostic" | "boolean";
  readonly jsonParser?: false | "native";
  readonly diagnosticMode?: "valid-first" | "single-pass";
}

export interface CompiledArtifact {
  readonly backend: "javascript" | "wasm";
  /** Paired files emitted by one schema compilation. */
  readonly files: CompiledFiles;
  /** @deprecated Use files.javascript. */
  readonly code: string;
  /** @deprecated Use files.typescript. */
  readonly declaration: string;
  readonly ir: SchemaIR;
}

export interface CompiledFiles {
  readonly javascript: string;
  readonly typescript: string;
  readonly wasm?: Uint8Array;
}

export interface GeneratedIssueArguments {
  readonly type: readonly [expected: string];
  readonly required: readonly [];
  readonly literal: readonly [expected: LiteralValue];
  readonly union: readonly [];
  readonly integer: readonly [];
  readonly min_value: readonly [requirement: number];
  readonly max_value: readonly [requirement: number];
  readonly greater_than: readonly [requirement: number];
  readonly less_than: readonly [requirement: number];
  readonly min_length: readonly [requirement: number];
  readonly max_length: readonly [requirement: number];
  readonly unknown_key: readonly [];
  readonly never: readonly [];
  readonly invalid_json: readonly [];
}

export type GeneratedIssueCode = keyof GeneratedIssueArguments;

export type GeneratedIssue<Code extends GeneratedIssueCode = GeneratedIssueCode> = Code extends
  GeneratedIssueCode ? {
    readonly code: Code;
    readonly args: GeneratedIssueArguments[Code];
    readonly path: readonly (string | number)[];
  }
  : never;

export interface GeneratedStandardIssue {
  readonly message: string;
  readonly path: readonly (string | number)[];
}

export type GeneratedResult<Output = unknown> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly [GeneratedIssue] };

export type GeneratedStandardResult<Output = unknown> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly [GeneratedStandardIssue] };

export interface GeneratedValidatorModule<Output = unknown> {
  readonly is: (input: unknown) => input is Output;
  readonly validate: (input: unknown) => GeneratedResult<Output>;
  readonly parseJSON?: (input: string) => GeneratedResult<Output>;
  readonly schema: {
    readonly "~standard": {
      readonly version: 1;
      readonly vendor: "jsimd-validator/aot";
      readonly validate: (input: unknown) => GeneratedStandardResult<Output>;
    };
  };
  readonly default: GeneratedValidatorModule<Output>["schema"];
}

export interface GeneratedDiagnosticModule<Output = unknown> {
  readonly is: (input: unknown) => input is Output;
  readonly validate: (input: unknown) => GeneratedResult<Output>;
  readonly parseJSON?: (input: string) => GeneratedResult<Output>;
}

export interface GeneratedBooleanModule<Output = unknown> {
  readonly is: (input: unknown) => input is Output;
}

export interface GeneratedWasmBooleanFactory<Output = unknown> {
  readonly instantiate: (
    source: ArrayBuffer | Uint8Array | WebAssembly.Module,
  ) => GeneratedBooleanModule<Output>;
}
