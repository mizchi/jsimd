import type { LiteralValue } from "./diagnostics.ts";

export type {
  IssueArguments,
  IssueCode,
  LiteralValue,
  SafeParseResult,
  ValidationIssue,
} from "./diagnostics.ts";

declare const output: unique symbol;

export interface BaseSchema<Output> {
  readonly kind: string;
  readonly [output]: Output;
}

export type AnySchema = BaseSchema<unknown>;
export type InferOutput<Schema extends AnySchema> = Schema[typeof output];

export interface StringSchema extends BaseSchema<string> {
  readonly kind: "string";
}

export interface NumberSchema extends BaseSchema<number> {
  readonly kind: "number";
}

export interface BooleanSchema extends BaseSchema<boolean> {
  readonly kind: "boolean";
}

export interface LiteralSchema<Value extends LiteralValue> extends BaseSchema<Value> {
  readonly kind: "literal";
  readonly value: Value;
}

export interface ArraySchema<Item extends AnySchema>
  extends BaseSchema<readonly InferOutput<Item>[]> {
  readonly kind: "array";
  readonly item: Item;
}

export type ObjectEntries = Readonly<Record<string, AnySchema>>;

type OptionalKeys<Entries extends ObjectEntries> = {
  [Key in keyof Entries]: undefined extends InferOutput<Entries[Key]> ? Key : never;
}[keyof Entries];

type RequiredKeys<Entries extends ObjectEntries> = Exclude<keyof Entries, OptionalKeys<Entries>>;

export type ObjectOutput<Entries extends ObjectEntries> =
  & {
    readonly [Key in RequiredKeys<Entries>]: InferOutput<Entries[Key]>;
  }
  & {
    readonly [Key in OptionalKeys<Entries>]?: Exclude<InferOutput<Entries[Key]>, undefined>;
  };

export interface ObjectSchema<Entries extends ObjectEntries>
  extends BaseSchema<ObjectOutput<Entries>> {
  readonly kind: "object";
  readonly entries: Entries;
}

export interface UnionSchema<Options extends readonly AnySchema[]>
  extends BaseSchema<InferOutput<Options[number]>> {
  readonly kind: "union";
  readonly options: Options;
}

export interface OptionalSchema<Inner extends AnySchema>
  extends BaseSchema<InferOutput<Inner> | undefined> {
  readonly kind: "optional";
  readonly inner: Inner;
}

export interface NullableSchema<Inner extends AnySchema>
  extends BaseSchema<InferOutput<Inner> | null> {
  readonly kind: "nullable";
  readonly inner: Inner;
}

export interface ValidationAction<Input> {
  readonly kind: string;
  readonly "~input"?: (input: Input) => void;
}

export interface IntegerAction extends ValidationAction<number> {
  readonly kind: "integer";
}

export interface MinValueAction extends ValidationAction<number> {
  readonly kind: "min_value";
  readonly requirement: number;
}

export interface MaxValueAction extends ValidationAction<number> {
  readonly kind: "max_value";
  readonly requirement: number;
}

export type LengthValue = string | readonly unknown[];

export interface MinLengthAction extends ValidationAction<LengthValue> {
  readonly kind: "min_length";
  readonly requirement: number;
}

export interface MaxLengthAction extends ValidationAction<LengthValue> {
  readonly kind: "max_length";
  readonly requirement: number;
}

export type AnyAction =
  | IntegerAction
  | MinValueAction
  | MaxValueAction
  | MinLengthAction
  | MaxLengthAction;

export interface PipeSchema<Inner extends AnySchema> extends BaseSchema<InferOutput<Inner>> {
  readonly kind: "pipe";
  readonly inner: Inner;
  readonly actions: readonly AnyAction[];
}

export interface CompiledSchema<Source extends AnySchema> extends BaseSchema<InferOutput<Source>> {
  readonly kind: "compiled";
  readonly source: Source;
  readonly check: (input: unknown) => input is InferOutput<Source>;
}

export type SchemaNode =
  | StringSchema
  | NumberSchema
  | BooleanSchema
  | LiteralSchema<LiteralValue>
  | ArraySchema<AnySchema>
  | ObjectSchema<ObjectEntries>
  | UnionSchema<readonly AnySchema[]>
  | OptionalSchema<AnySchema>
  | NullableSchema<AnySchema>
  | PipeSchema<AnySchema>
  | CompiledSchema<AnySchema>;
