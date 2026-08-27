import {
  AdaptiveI32Column,
  AdaptiveU32Column,
  BitSlicedU8Column,
  SelectionMask,
} from "../../src/columnar/mod.ts";
import type { PageBackend } from "./backend.ts";
import { decodeColumnPage, encodeColumnPage } from "./page_format.ts";
import {
  type ColumnDefinition,
  type ColumnOutput,
  type SchemaDefinition,
  schemaFingerprint,
  type TableDefinition,
  type TableInput,
} from "./schema.ts";

const MANIFEST_VERSION = 1;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type TableName<Schema extends SchemaDefinition> = keyof Schema["tables"] & string;
type ColumnName<Table extends TableDefinition> = keyof Table["columns"] & string;
type NumericArray = Int32Array | Uint32Array | Uint8Array;

interface ColumnManifest {
  readonly key: string;
  readonly kind: ColumnDefinition["kind"];
  readonly format: PageFormat;
  readonly min: number;
  readonly max: number;
  readonly byteLength: number;
}

interface RowGroupManifest {
  readonly index: number;
  readonly rowOffset: number;
  readonly length: number;
  readonly columns: Readonly<Record<string, ColumnManifest>>;
}

interface TableManifest {
  readonly version: number;
  readonly generation: string;
  readonly fingerprint: string;
  readonly rowCount: number;
  readonly rowGroupSize: number;
  readonly rowGroups: readonly RowGroupManifest[];
}

export type PredicateOperator = "eq" | "lt" | "between";

interface Predicate {
  readonly column: string;
  readonly operator: PredicateOperator;
  readonly minimum: number;
  readonly maximum?: number;
}

export interface QueryStats {
  readonly rowGroupsTotal: number;
  readonly rowGroupsSkipped: number;
  readonly pagesRead: number;
  readonly cacheHits: number;
  readonly bytesRead: number;
  readonly rowsMatched: number;
}

export type QueryColumns<
  Table extends TableDefinition,
  Selected extends ColumnName<Table>,
> = {
  readonly [Name in Selected]: ColumnOutput<Table["columns"][Name]>;
};

export interface QueryResult<
  Table extends TableDefinition,
  Selected extends ColumnName<Table>,
> {
  readonly rowIds: Uint32Array;
  readonly columns: QueryColumns<Table, Selected>;
  readonly stats: QueryStats;
}

export interface CountResult {
  readonly value: number;
  readonly stats: QueryStats;
}

interface MutableStats {
  rowGroupsTotal: number;
  rowGroupsSkipped: number;
  pagesRead: number;
  cacheHits: number;
  bytesRead: number;
  rowsMatched: number;
}

type ResidentColumn = AdaptiveI32Column | AdaptiveU32Column | BitSlicedU8Column;
export type PageFormat = "raw" | "snapshot";

class CachedColumnPage {
  readonly key: string;
  readonly values: NumericArray | undefined;
  readonly byteLength: number;
  readonly #definition: ColumnDefinition;
  #resident: ResidentColumn | undefined;
  pins = 0;

  constructor(
    key: string,
    definition: ColumnDefinition,
    values: NumericArray | undefined,
    byteLength: number,
    resident?: ResidentColumn,
  ) {
    this.key = key;
    this.#definition = definition;
    this.values = values;
    this.byteLength = byteLength;
    this.#resident = resident;
  }

  resident(): ResidentColumn {
    if (this.#resident !== undefined) return this.#resident;
    this.#resident = this.#definition.kind === "i32"
      ? AdaptiveI32Column.from(this.values as Int32Array)
      : this.#definition.kind === "u32"
      ? AdaptiveU32Column.from(this.values as Uint32Array)
      : BitSlicedU8Column.from(this.values as Uint8Array, this.#definition.bitWidth);
    return this.#resident;
  }

  gatherInto(selection: SelectionMask, output: NumericArray): number {
    const resident = this.resident();
    if (this.#definition.kind === "i32") {
      return (resident as AdaptiveI32Column).gatherInto(selection, output as Int32Array);
    }
    if (this.#definition.kind === "u32") {
      return (resident as AdaptiveU32Column).gatherInto(selection, output as Uint32Array);
    }
    return (resident as BitSlicedU8Column).gatherInto(selection, output as Uint8Array);
  }

  [Symbol.dispose](): void {
    this.#resident?.[Symbol.dispose]();
    this.#resident = undefined;
  }
}

interface PageLease {
  readonly page: CachedColumnPage;
  readonly hit: boolean;
  release(): void;
}

class ResidentPageCache {
  readonly #maximumBytes: number;
  readonly #pages = new Map<string, CachedColumnPage>();
  readonly #loads = new Map<string, Promise<CachedColumnPage>>();
  #bytes = 0;

  constructor(maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
      throw new RangeError("cacheBytes must be a non-negative safe integer");
    }
    this.#maximumBytes = maximumBytes;
  }

  async acquire(
    backend: PageBackend,
    key: string,
    definition: ColumnDefinition,
    format: PageFormat,
    expectedLength: number,
    expectedBytes: number,
    stats: MutableStats,
  ): Promise<PageLease> {
    let page = this.#pages.get(key);
    let hit = page !== undefined;
    if (page === undefined) {
      let loading = this.#loads.get(key);
      if (loading === undefined) {
        loading = this.#load(
          backend,
          key,
          definition,
          format,
          expectedLength,
          expectedBytes,
        );
        this.#loads.set(key, loading);
        try {
          page = await loading;
        } finally {
          if (this.#loads.get(key) === loading) this.#loads.delete(key);
        }
        stats.pagesRead++;
        stats.bytesRead += page.byteLength;
      } else {
        page = await loading;
        hit = true;
        stats.cacheHits++;
      }
    } else {
      this.#pages.delete(key);
      this.#pages.set(key, page);
      stats.cacheHits++;
    }
    page.pins++;
    let released = false;
    return {
      page,
      hit,
      release: () => {
        if (released) return;
        released = true;
        page!.pins--;
        this.#evict();
      },
    };
  }

  async #load(
    backend: PageBackend,
    key: string,
    definition: ColumnDefinition,
    format: PageFormat,
    expectedLength: number,
    expectedBytes: number,
  ): Promise<CachedColumnPage> {
    const bytes = await backend.get(key);
    if (bytes === undefined) throw new Error(`missing column page ${key}`);
    if (bytes.byteLength !== expectedBytes) {
      throw new RangeError(`column page ${key} byte mismatch`);
    }
    let page: CachedColumnPage;
    if (format === "raw") {
      const values = decodeColumnPage(definition, bytes);
      if (values.length !== expectedLength) {
        throw new RangeError(`column page ${key} length mismatch`);
      }
      page = new CachedColumnPage(key, definition, values, bytes.byteLength);
    } else {
      const resident = restoreResidentColumn(definition, bytes);
      if (resident.length !== expectedLength) {
        resident[Symbol.dispose]();
        throw new RangeError(`column page ${key} length mismatch`);
      }
      page = new CachedColumnPage(key, definition, undefined, bytes.byteLength, resident);
    }
    this.#pages.set(key, page);
    this.#bytes += page.byteLength;
    return page;
  }

  clear(prefix = ""): void {
    for (const [key, page] of this.#pages) {
      if (!key.startsWith(prefix) || page.pins !== 0) continue;
      this.#pages.delete(key);
      this.#bytes -= page.byteLength;
      page[Symbol.dispose]();
    }
  }

  [Symbol.dispose](): void {
    for (const page of this.#pages.values()) page[Symbol.dispose]();
    this.#pages.clear();
    this.#bytes = 0;
  }

  #evict(): void {
    if (this.#bytes <= this.#maximumBytes) return;
    for (const [key, page] of this.#pages) {
      if (this.#bytes <= this.#maximumBytes) break;
      if (page.pins !== 0) continue;
      this.#pages.delete(key);
      this.#bytes -= page.byteLength;
      page[Symbol.dispose]();
    }
  }
}

export class SchemaEngine<Schema extends SchemaDefinition> {
  readonly schema: Schema;
  readonly backend: PageBackend;
  readonly #cache: ResidentPageCache;
  readonly #manifests = new Map<string, TableManifest>();
  readonly #pageFormat: PageFormat;
  #disposed = false;

  constructor(
    schema: Schema,
    backend: PageBackend,
    options: { readonly cacheBytes?: number; readonly pageFormat?: PageFormat } = {},
  ) {
    this.schema = schema;
    this.backend = backend;
    this.#cache = new ResidentPageCache(options.cacheBytes ?? 64 * 1024 * 1024);
    this.#pageFormat = options.pageFormat ?? "snapshot";
  }

  async replace<Name extends TableName<Schema>>(
    name: Name,
    input: TableInput<Schema["tables"][Name]>,
  ): Promise<void> {
    this.#assertAlive();
    const table = this.#table(name);
    const columnNames = Object.keys(table.columns);
    const length = validateTableInput(table, input);
    const generation = `${Date.now()}-${crypto.randomUUID()}`;
    const rowGroups: RowGroupManifest[] = [];
    for (
      let rowOffset = 0, index = 0;
      rowOffset < length;
      rowOffset += table.rowGroupSize, index++
    ) {
      const pageLength = Math.min(table.rowGroupSize, length - rowOffset);
      const columns: Record<string, ColumnManifest> = {};
      for (const columnName of columnNames) {
        const definition = table.columns[columnName]!;
        const values = (input as Readonly<Record<string, NumericArray>>)[columnName]!;
        const pageValues = values.slice(rowOffset, rowOffset + pageLength) as NumericArray;
        const bytes = this.#pageFormat === "raw"
          ? encodeColumnPage(definition, pageValues)
          : serializeResidentColumn(definition, pageValues);
        const key = `tables/${name}/pages/${generation}/${index}/${columnName}.bin`;
        await this.backend.put(key, bytes);
        const [minimum, maximum] = minMax(pageValues);
        columns[columnName] = Object.freeze({
          key,
          kind: definition.kind,
          format: this.#pageFormat,
          min: minimum,
          max: maximum,
          byteLength: bytes.byteLength,
        });
      }
      rowGroups.push(Object.freeze({
        index,
        rowOffset,
        length: pageLength,
        columns: Object.freeze(columns),
      }));
    }
    const manifest: TableManifest = Object.freeze({
      version: MANIFEST_VERSION,
      generation,
      fingerprint: schemaFingerprint(table),
      rowCount: length,
      rowGroupSize: table.rowGroupSize,
      rowGroups: Object.freeze(rowGroups),
    });
    await this.backend.put(manifestKey(name), textEncoder.encode(JSON.stringify(manifest)));
    this.#manifests.set(name, manifest);
    this.#cache.clear(`tables/${name}/pages/`);
  }

  query<Name extends TableName<Schema>>(
    name: Name,
  ): QueryBuilder<
    Schema["tables"][Name],
    ColumnName<Schema["tables"][Name]>,
    Schema
  > {
    this.#assertAlive();
    return new QueryBuilder(this, name, this.#table(name));
  }

  clearCache(): void {
    this.#assertAlive();
    this.#cache.clear();
  }

  /** Reloads a table manifest published by another engine and drops its resident pages. */
  async refresh<Name extends TableName<Schema>>(name: Name): Promise<void> {
    this.#assertAlive();
    const table = this.#table(name);
    const manifest = await this.#readManifest(name, table);
    this.#manifests.set(name, manifest);
    this.#cache.clear(`tables/${name}/pages/`);
  }

  async vacuum<Name extends TableName<Schema>>(name: Name): Promise<number> {
    this.#assertAlive();
    const manifest = await this.#manifest(name, this.#table(name));
    const prefix = `tables/${name}/pages/`;
    const currentPrefix = `${prefix}${manifest.generation}/`;
    const obsolete = (await this.backend.list(prefix)).filter((key) =>
      !key.startsWith(currentPrefix)
    );
    await Promise.all(obsolete.map((key) => this.backend.delete(key)));
    this.#cache.clear(prefix);
    return obsolete.length;
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cache[Symbol.dispose]();
    this.#manifests.clear();
    this.backend[Symbol.dispose]?.();
  }

  async execute<Table extends TableDefinition, Selected extends ColumnName<Table>>(
    tableName: string,
    table: Table,
    predicates: readonly Predicate[],
    selected: readonly Selected[],
    materialize: boolean,
  ): Promise<QueryResult<Table, Selected> | CountResult> {
    this.#assertAlive();
    const manifest = await this.#manifest(tableName, table);
    const stats: MutableStats = {
      rowGroupsTotal: manifest.rowGroups.length,
      rowGroupsSkipped: 0,
      pagesRead: 0,
      cacheHits: 0,
      bytesRead: 0,
      rowsMatched: 0,
    };
    const rowIdChunks: Uint32Array[] = [];
    const chunks = new Map<string, NumericArray[]>();
    for (const name of selected) chunks.set(name, []);

    for (const group of manifest.rowGroups) {
      if (predicates.some((predicate) => !mayMatch(group.columns[predicate.column]!, predicate))) {
        stats.rowGroupsSkipped++;
        continue;
      }
      const needed = new Set<string>(predicates.map((predicate) => predicate.column));
      if (materialize) { for (const name of selected) needed.add(name); }
      const leases = new Map<string, PageLease>();
      try {
        await Promise.all(Array.from(needed, async (columnName) => {
          const definition = table.columns[columnName];
          const metadata = group.columns[columnName];
          if (definition === undefined || metadata === undefined) {
            throw new RangeError(`manifest is missing column ${columnName}`);
          }
          const lease = await this.#cache.acquire(
            this.backend,
            metadata.key,
            definition,
            metadata.format,
            group.length,
            metadata.byteLength,
            stats,
          );
          leases.set(columnName, lease);
        }));

        using selection = new SelectionMask(group.length);
        using temporary = new SelectionMask(group.length);
        selection.fill();
        for (const predicate of predicates) {
          const resident = leases.get(predicate.column)!.page.resident();
          scan(resident, predicate, temporary);
          selection.andAssign(temporary);
          if (selection.countOnes() === 0) break;
        }
        const count = selection.countOnes();
        stats.rowsMatched += count;
        if (!materialize || count === 0) continue;
        const localRows = selection.toIndices();
        const rowIds = new Uint32Array(localRows.length);
        for (let index = 0; index < localRows.length; index++) {
          rowIds[index] = group.rowOffset + localRows[index]!;
        }
        rowIdChunks.push(rowIds);
        for (const columnName of selected) {
          const page = leases.get(columnName)!.page;
          const output = newTypedArray(table.columns[columnName]!, localRows.length);
          const written = page.gatherInto(selection, output);
          if (written !== localRows.length) throw new Error("projected column length mismatch");
          chunks.get(columnName)!.push(output);
        }
      } finally {
        for (const lease of leases.values()) lease.release();
      }
    }

    const frozenStats = Object.freeze({ ...stats });
    if (!materialize) return Object.freeze({ value: stats.rowsMatched, stats: frozenStats });
    const columns: Record<string, NumericArray> = {};
    for (const columnName of selected) {
      columns[columnName] = concatenate(table.columns[columnName]!, chunks.get(columnName)!);
    }
    return Object.freeze({
      rowIds: concatenateU32(rowIdChunks),
      columns: Object.freeze(columns) as QueryColumns<Table, Selected>,
      stats: frozenStats,
    });
  }

  #table<Name extends TableName<Schema>>(name: Name): Schema["tables"][Name] {
    const table = this.schema.tables[name];
    if (table === undefined) throw new RangeError(`unknown table ${name}`);
    return table as Schema["tables"][Name];
  }

  async #manifest(name: string, table: TableDefinition): Promise<TableManifest> {
    const cached = this.#manifests.get(name);
    if (cached !== undefined) return cached;
    const manifest = await this.#readManifest(name, table);
    this.#manifests.set(name, manifest);
    return manifest;
  }

  async #readManifest(name: string, table: TableDefinition): Promise<TableManifest> {
    const bytes = await this.backend.get(manifestKey(name));
    if (bytes === undefined) throw new Error(`table ${name} has not been written`);
    let value: unknown;
    try {
      value = JSON.parse(textDecoder.decode(bytes));
    } catch (error) {
      throw new RangeError(`invalid table manifest: ${String(error)}`);
    }
    const manifest = validateManifest(value);
    if (manifest.fingerprint !== schemaFingerprint(table)) {
      throw new RangeError(`schema mismatch for table ${name}`);
    }
    return manifest;
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("SchemaEngine has been disposed");
  }
}

export class QueryBuilder<
  Table extends TableDefinition,
  Selected extends ColumnName<Table>,
  Schema extends SchemaDefinition = SchemaDefinition,
> {
  readonly #engine: SchemaEngine<Schema>;
  readonly #tableName: string;
  readonly #table: Table;
  readonly #predicates: readonly Predicate[];
  readonly #selected: readonly ColumnName<Table>[];

  constructor(
    engine: SchemaEngine<Schema>,
    tableName: string,
    table: Table,
    predicates: readonly Predicate[] = [],
    selected: readonly ColumnName<Table>[] = Object.keys(table.columns) as ColumnName<Table>[],
  ) {
    this.#engine = engine;
    this.#tableName = tableName;
    this.#table = table;
    this.#predicates = predicates;
    this.#selected = selected;
  }

  where<Name extends ColumnName<Table>>(
    column: Name,
    operator: "eq" | "lt",
    value: number,
  ): QueryBuilder<Table, Selected, Schema>;
  where<Name extends ColumnName<Table>>(
    column: Name,
    operator: "between",
    minimum: number,
    maximum: number,
  ): QueryBuilder<Table, Selected, Schema>;
  where<Name extends ColumnName<Table>>(
    column: Name,
    operator: PredicateOperator,
    minimum: number,
    maximum?: number,
  ): QueryBuilder<Table, Selected, Schema> {
    if (this.#table.columns[column] === undefined) throw new RangeError(`unknown column ${column}`);
    validatePredicateValue(minimum);
    if (operator === "between") {
      if (maximum === undefined) throw new TypeError("between requires a maximum");
      validatePredicateValue(maximum);
    }
    const predicate = Object.freeze({ column, operator, minimum, maximum });
    return new QueryBuilder(
      this.#engine,
      this.#tableName,
      this.#table,
      [...this.#predicates, predicate],
      this.#selected,
    );
  }

  select<const Names extends readonly ColumnName<Table>[]>(
    ...names: Names
  ): QueryBuilder<Table, Names[number], Schema> {
    const unique = new Set(names);
    if (unique.size !== names.length) throw new RangeError("projection columns must be unique");
    for (const name of names) {
      if (this.#table.columns[name] === undefined) throw new RangeError(`unknown column ${name}`);
    }
    return new QueryBuilder(
      this.#engine,
      this.#tableName,
      this.#table,
      this.#predicates,
      Array.from(names),
    ) as QueryBuilder<Table, Names[number], Schema>;
  }

  execute(): Promise<QueryResult<Table, Selected>> {
    return this.#engine.execute(
      this.#tableName,
      this.#table,
      this.#predicates,
      this.#selected as Selected[],
      true,
    ) as Promise<QueryResult<Table, Selected>>;
  }

  count(): Promise<CountResult> {
    return this.#engine.execute(
      this.#tableName,
      this.#table,
      this.#predicates,
      [],
      false,
    ) as Promise<CountResult>;
  }
}

function scan(column: ResidentColumn, predicate: Predicate, output: SelectionMask): void {
  if (predicate.operator === "eq") column.scanEq(predicate.minimum, output);
  else if (predicate.operator === "lt") column.scanLt(predicate.minimum, output);
  else column.scanBetween(predicate.minimum, predicate.maximum!, output);
}

function serializeResidentColumn(definition: ColumnDefinition, values: NumericArray): Uint8Array {
  using resident = createResidentColumn(definition, values);
  return resident.serialize();
}

function createResidentColumn(
  definition: ColumnDefinition,
  values: NumericArray,
): ResidentColumn {
  if (definition.kind === "i32") return AdaptiveI32Column.from(values as Int32Array);
  if (definition.kind === "u32") return AdaptiveU32Column.from(values as Uint32Array);
  return BitSlicedU8Column.from(values as Uint8Array, definition.bitWidth);
}

function restoreResidentColumn(
  definition: ColumnDefinition,
  snapshot: Uint8Array,
): ResidentColumn {
  if (definition.kind === "i32") return AdaptiveI32Column.fromSnapshot(snapshot);
  if (definition.kind === "u32") return AdaptiveU32Column.fromSnapshot(snapshot);
  return BitSlicedU8Column.fromSnapshot(snapshot);
}

function mayMatch(metadata: ColumnManifest, predicate: Predicate): boolean {
  if (predicate.operator === "eq") {
    return predicate.minimum >= metadata.min && predicate.minimum <= metadata.max;
  }
  if (predicate.operator === "lt") return metadata.min < predicate.minimum;
  return predicate.minimum < predicate.maximum! && metadata.max >= predicate.minimum &&
    metadata.min < predicate.maximum!;
}

function validateTableInput(table: TableDefinition, input: object): number {
  let length: number | undefined;
  for (const [name, definition] of Object.entries(table.columns)) {
    const value = (input as Readonly<Record<string, unknown>>)[name];
    const valid = definition.kind === "i32"
      ? value instanceof Int32Array
      : definition.kind === "u32"
      ? value instanceof Uint32Array
      : value instanceof Uint8Array;
    if (!valid) throw new TypeError(`column ${name} must be a ${typedArrayName(definition)}`);
    const values = value as NumericArray;
    if (length === undefined) length = values.length;
    else if (length !== values.length) throw new RangeError("all columns must have equal length");
    if (definition.kind === "u8") {
      const limit = 2 ** definition.bitWidth;
      for (const item of values) {
        if (item >= limit) {
          throw new RangeError(`column ${name} contains a value outside its bit width`);
        }
      }
    }
  }
  return length ?? 0;
}

function typedArrayName(definition: ColumnDefinition): string {
  if (definition.kind === "i32") return "Int32Array";
  if (definition.kind === "u32") return "Uint32Array";
  return "Uint8Array";
}

function minMax(values: NumericArray): readonly [number, number] {
  let minimum = values[0] ?? 0;
  let maximum = minimum;
  for (let index = 1; index < values.length; index++) {
    const value = values[index]!;
    if (value < minimum) minimum = value;
    if (value > maximum) maximum = value;
  }
  return [minimum, maximum];
}

function newTypedArray(definition: ColumnDefinition, length: number): NumericArray {
  if (definition.kind === "i32") return new Int32Array(length);
  if (definition.kind === "u32") return new Uint32Array(length);
  return new Uint8Array(length);
}

function concatenate(definition: ColumnDefinition, chunks: readonly NumericArray[]): NumericArray {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const output = newTypedArray(definition, length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function concatenateU32(chunks: readonly Uint32Array[]): Uint32Array {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const output = new Uint32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function validatePredicateValue(value: number): void {
  if (!Number.isSafeInteger(value)) throw new RangeError("predicate values must be safe integers");
}

function manifestKey(name: string): string {
  return `tables/${name}/manifest.json`;
}

function validateManifest(value: unknown): TableManifest {
  if (typeof value !== "object" || value === null) throw new RangeError("invalid table manifest");
  const candidate = value as Partial<TableManifest>;
  if (
    candidate.version !== MANIFEST_VERSION || typeof candidate.generation !== "string" ||
    typeof candidate.fingerprint !== "string" || !Number.isSafeInteger(candidate.rowCount) ||
    !Number.isSafeInteger(candidate.rowGroupSize) || !Array.isArray(candidate.rowGroups)
  ) {
    throw new RangeError("invalid table manifest");
  }
  for (const group of candidate.rowGroups) {
    if (
      typeof group !== "object" || group === null || !Number.isSafeInteger(group.index) ||
      !Number.isSafeInteger(group.rowOffset) || !Number.isSafeInteger(group.length) ||
      typeof group.columns !== "object" || group.columns === null
    ) throw new RangeError("invalid row-group manifest");
    for (const metadata of Object.values(group.columns)) {
      const column = metadata as Partial<ColumnManifest>;
      if (
        typeof metadata !== "object" || metadata === null || typeof column.key !== "string" ||
        typeof column.kind !== "string" || !["i32", "u32", "u8"].includes(column.kind) ||
        typeof column.format !== "string" || !["raw", "snapshot"].includes(column.format) ||
        typeof column.min !== "number" || typeof column.max !== "number" ||
        !Number.isSafeInteger(column.byteLength)
      ) throw new RangeError("invalid column manifest");
    }
  }
  return candidate as TableManifest;
}
