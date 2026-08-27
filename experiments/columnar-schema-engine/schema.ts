export interface ColumnOptions<Value> {
  readonly nullable?: boolean;
  readonly default?: Value | null;
}

export interface I32ColumnDefinition<Nullable extends boolean = boolean> {
  readonly kind: "i32";
  readonly nullable: Nullable;
  readonly default?: number | null;
}

export interface U32ColumnDefinition<Nullable extends boolean = boolean> {
  readonly kind: "u32";
  readonly nullable: Nullable;
  readonly default?: number | null;
}

export interface U8ColumnDefinition<Nullable extends boolean = boolean> {
  readonly kind: "u8";
  readonly bitWidth: number;
  readonly nullable: Nullable;
  readonly default?: number | null;
}

export interface StringColumnDefinition<Nullable extends boolean = boolean> {
  readonly kind: "string";
  readonly nullable: Nullable;
  readonly default?: string | null;
}

export type ColumnDefinition =
  | I32ColumnDefinition
  | U32ColumnDefinition
  | U8ColumnDefinition
  | StringColumnDefinition;
export type ColumnDefinitions = Readonly<Record<string, ColumnDefinition>>;

export interface NullableColumn<Values extends Int32Array | Uint32Array | Uint8Array> {
  readonly values: Values;
  /** One byte per row. Zero means null and any non-zero value means valid. */
  readonly validity: Uint8Array;
}

export interface TableDefinition<Columns extends ColumnDefinitions = ColumnDefinitions> {
  readonly columns: Columns;
  readonly rowGroupSize: number;
}

export interface SchemaDefinition<
  Tables extends Readonly<Record<string, TableDefinition>> = Readonly<
    Record<string, TableDefinition>
  >,
> {
  readonly tables: Tables;
}

type NumericInput<
  Definition extends { readonly nullable: boolean },
  Values extends Int32Array | Uint32Array | Uint8Array,
> = Definition["nullable"] extends true ? NullableColumn<Values> : Values;

export type ColumnInput<Definition extends ColumnDefinition> = Definition extends
  I32ColumnDefinition ? NumericInput<Definition, Int32Array>
  : Definition extends U32ColumnDefinition ? NumericInput<Definition, Uint32Array>
  : Definition extends U8ColumnDefinition ? NumericInput<Definition, Uint8Array>
  : Definition extends StringColumnDefinition<true> ? readonly (string | null)[]
  : readonly string[];

export type TableInput<Table extends TableDefinition> = {
  readonly [Name in keyof Table["columns"]]: ColumnInput<Table["columns"][Name]>;
};

export type ColumnOutput<Definition extends ColumnDefinition> = ColumnInput<Definition>;

export function nullable<Values extends Int32Array | Uint32Array | Uint8Array>(
  values: Values,
  validity: Uint8Array,
): NullableColumn<Values> {
  if (!(validity instanceof Uint8Array) || validity.length !== values.length) {
    throw new RangeError("validity must have one byte per value");
  }
  return Object.freeze({ values, validity });
}

export function i32(): I32ColumnDefinition<false>;
export function i32(
  options: ColumnOptions<number> & { readonly nullable: true },
): I32ColumnDefinition<true>;
export function i32(options: ColumnOptions<number>): I32ColumnDefinition<false>;
export function i32(options: ColumnOptions<number> = {}): I32ColumnDefinition {
  return numericDefinition("i32", options) as I32ColumnDefinition;
}

export function u32(): U32ColumnDefinition<false>;
export function u32(
  options: ColumnOptions<number> & { readonly nullable: true },
): U32ColumnDefinition<true>;
export function u32(options: ColumnOptions<number>): U32ColumnDefinition<false>;
export function u32(options: ColumnOptions<number> = {}): U32ColumnDefinition {
  return numericDefinition("u32", options) as U32ColumnDefinition;
}

export interface U8ColumnOptions extends ColumnOptions<number> {
  readonly bitWidth?: number;
}

export function u8(
  options: U8ColumnOptions & { readonly nullable: true },
): U8ColumnDefinition<true>;
export function u8(options?: U8ColumnOptions): U8ColumnDefinition<false>;
export function u8(options: U8ColumnOptions = {}): U8ColumnDefinition {
  const bitWidth = options.bitWidth ?? 8;
  if (!Number.isInteger(bitWidth) || bitWidth < 1 || bitWidth > 8) {
    throw new RangeError("u8 bitWidth must be an integer from 1 through 8");
  }
  validateDefault("u8", options, 2 ** bitWidth - 1);
  return Object.freeze({
    kind: "u8",
    bitWidth,
    nullable: options.nullable === true,
    ...(Object.hasOwn(options, "default") ? { default: options.default } : {}),
  });
}

export function string(): StringColumnDefinition<false>;
export function string(
  options: ColumnOptions<string> & { readonly nullable: true },
): StringColumnDefinition<true>;
export function string(options: ColumnOptions<string>): StringColumnDefinition<false>;
export function string(options: ColumnOptions<string> = {}): StringColumnDefinition {
  if (options.default === null && options.nullable !== true) {
    throw new RangeError("a null default requires nullable: true");
  }
  if (
    options.default !== undefined && options.default !== null &&
    typeof options.default !== "string"
  ) {
    throw new TypeError("string default must be a string or null");
  }
  return Object.freeze({
    kind: "string",
    nullable: options.nullable === true,
    ...(Object.hasOwn(options, "default") ? { default: options.default } : {}),
  });
}

export function defineTable<const Columns extends ColumnDefinitions>(
  columns: Columns,
  options: { readonly rowGroupSize?: number } = {},
): TableDefinition<Columns> {
  const names = Object.keys(columns);
  if (names.length === 0) throw new RangeError("a table must define at least one column");
  for (const name of names) validateName(name, "column");
  const rowGroupSize = options.rowGroupSize ?? 65_536;
  if (!Number.isSafeInteger(rowGroupSize) || rowGroupSize < 256 || rowGroupSize % 256 !== 0) {
    throw new RangeError("rowGroupSize must be a positive multiple of 256");
  }
  return Object.freeze({ columns: Object.freeze({ ...columns }), rowGroupSize });
}

export function defineSchema<
  const Tables extends Readonly<Record<string, TableDefinition>>,
>(tables: Tables): SchemaDefinition<Tables> {
  const names = Object.keys(tables);
  if (names.length === 0) throw new RangeError("a schema must define at least one table");
  for (const name of names) validateName(name, "table");
  return Object.freeze({ tables: Object.freeze({ ...tables }) });
}

export function schemaFingerprint(table: TableDefinition): string {
  const columns = Object.keys(table.columns).sort().map((name) => {
    const column = table.columns[name]!;
    return [
      name,
      column.kind,
      column.kind === "u8" ? column.bitWidth : undefined,
      column.nullable,
      Object.hasOwn(column, "default") ? column.default : undefined,
    ];
  });
  return JSON.stringify({ rowGroupSize: table.rowGroupSize, columns });
}

function numericDefinition(
  kind: "i32" | "u32",
  options: ColumnOptions<number>,
): I32ColumnDefinition | U32ColumnDefinition {
  validateDefault(kind, options, kind === "i32" ? 0x7fff_ffff : 0xffff_ffff);
  return Object.freeze({
    kind,
    nullable: options.nullable === true,
    ...(Object.hasOwn(options, "default") ? { default: options.default } : {}),
  });
}

function validateDefault(
  kind: "i32" | "u32" | "u8",
  options: ColumnOptions<number>,
  maximum: number,
): void {
  if (options.default === null) {
    if (options.nullable !== true) throw new RangeError("a null default requires nullable: true");
    return;
  }
  if (options.default === undefined) return;
  const minimum = kind === "i32" ? -0x8000_0000 : 0;
  if (
    !Number.isInteger(options.default) || options.default < minimum || options.default > maximum
  ) {
    throw new RangeError(`${kind} default is outside its value range`);
  }
}

function validateName(name: string, kind: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
    throw new RangeError(`${kind} name ${JSON.stringify(name)} is not storage-safe`);
  }
}
