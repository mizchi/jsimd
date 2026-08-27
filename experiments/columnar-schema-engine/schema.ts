export interface I32ColumnDefinition {
  readonly kind: "i32";
}

export interface U32ColumnDefinition {
  readonly kind: "u32";
}

export interface U8ColumnDefinition {
  readonly kind: "u8";
  readonly bitWidth: number;
}

export type ColumnDefinition = I32ColumnDefinition | U32ColumnDefinition | U8ColumnDefinition;
export type ColumnDefinitions = Readonly<Record<string, ColumnDefinition>>;

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

export type ColumnInput<Definition extends ColumnDefinition> = Definition extends
  I32ColumnDefinition ? Int32Array
  : Definition extends U32ColumnDefinition ? Uint32Array
  : Uint8Array;

export type TableInput<Table extends TableDefinition> = {
  readonly [Name in keyof Table["columns"]]: ColumnInput<Table["columns"][Name]>;
};

export type ColumnOutput<Definition extends ColumnDefinition> = ColumnInput<Definition>;

export function i32(): I32ColumnDefinition {
  return Object.freeze({ kind: "i32" });
}

export function u32(): U32ColumnDefinition {
  return Object.freeze({ kind: "u32" });
}

export function u8(options: { readonly bitWidth?: number } = {}): U8ColumnDefinition {
  const bitWidth = options.bitWidth ?? 8;
  if (!Number.isInteger(bitWidth) || bitWidth < 1 || bitWidth > 8) {
    throw new RangeError("u8 bitWidth must be an integer from 1 through 8");
  }
  return Object.freeze({ kind: "u8", bitWidth });
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
    return column.kind === "u8" ? [name, column.kind, column.bitWidth] : [name, column.kind];
  });
  return JSON.stringify({ rowGroupSize: table.rowGroupSize, columns });
}

function validateName(name: string, kind: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
    throw new RangeError(`${kind} name ${JSON.stringify(name)} is not storage-safe`);
  }
}
