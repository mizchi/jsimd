import {
  AdaptiveI32Column,
  AdaptiveU32Column,
  BitSlicedU8Column,
  SelectionMask,
} from "@mizchi/jsimd/columnar";
import type { PageBackend } from "./backend.ts";
import { decodeColumnPage, encodeColumnPage } from "./page_format.ts";
import {
  type ColumnDefinition,
  type ColumnOutput,
  type NullableColumn,
  type RowGroupUpdate,
  type SchemaDefinition,
  schemaFingerprint,
  type TableDefinition,
  type TableInput,
} from "./schema.ts";
import {
  decodeDictionaryStringPage,
  decodeNullableStoredPage,
  type DictionaryStringPage,
  encodeDictionaryStringPage,
  encodeNullableStoredPage,
  stringPageHostBytes,
} from "./stored_page.ts";
import {
  acquireVersionedRowGroupPin,
  pinnedVersionedRowGroupPageKeys,
} from "./versioned_row_group.ts";

const MANIFEST_VERSION = 2;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type TableName<Schema extends SchemaDefinition> = keyof Schema["tables"] & string;
type ColumnName<Table extends TableDefinition> = keyof Table["columns"] & string;
type NumericArray = Int32Array | Uint32Array | Uint8Array;
type Scalar = number | string;
type ResidentColumn = AdaptiveI32Column | AdaptiveU32Column | BitSlicedU8Column;
type ColumnChunk = NumericArray | NullableColumn<NumericArray> | readonly (string | null)[];

interface StoredColumnDefinition {
  readonly kind: ColumnDefinition["kind"];
  readonly nullable: boolean;
  readonly bitWidth?: number;
}

interface ColumnManifest {
  readonly key: string;
  readonly kind: ColumnDefinition["kind"];
  readonly format: PageFormat;
  readonly min: Scalar | null;
  readonly max: Scalar | null;
  readonly nullCount: number;
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
  readonly definitions: Readonly<Record<string, StoredColumnDefinition>>;
  readonly rowCount: number;
  readonly rowGroupSize: number;
  readonly rowGroups: readonly RowGroupManifest[];
}

export type PredicateOperator = "eq" | "lt" | "between" | "is-null" | "is-not-null";

interface Predicate {
  readonly column: string;
  readonly operator: PredicateOperator;
  readonly minimum?: Scalar;
  readonly maximum?: Scalar;
}

export interface QueryStats {
  readonly rowGroupsTotal: number;
  readonly rowGroupsSkipped: number;
  readonly pagesRead: number;
  readonly cacheHits: number;
  readonly bytesRead: number;
  readonly rowsMatched: number;
}

export interface CacheStats {
  readonly maximumBytes: number;
  readonly hostBytes: number;
  readonly wasmBytes: number;
  readonly totalBytes: number;
  readonly pages: number;
  readonly evictions: number;
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

/** One immutable, encoded i32 row-group page read directly from a PageBackend. */
export interface I32SnapshotPage {
  readonly index: number;
  readonly rowOffset: number;
  readonly length: number;
  readonly min: number;
  readonly max: number;
  readonly byteLength: number;
  readonly bytes: Uint8Array;
}

/** A generation-consistent set of persisted i32 snapshots for shared physical execution. */
export interface I32SnapshotPages {
  readonly generation: string;
  readonly rowCount: number;
  readonly rowGroupSize: number;
  readonly bytesRead: number;
  readonly pages: readonly I32SnapshotPage[];
}

interface MutableStats {
  rowGroupsTotal: number;
  rowGroupsSkipped: number;
  pagesRead: number;
  cacheHits: number;
  bytesRead: number;
  rowsMatched: number;
}

interface PageFootprint {
  readonly hostBytes: number;
  readonly wasmBytes: number;
}

class CachedColumnPage {
  readonly key: string;
  readonly storedByteLength: number;
  readonly length: number;
  readonly #definition: ColumnDefinition;
  readonly #onFootprintChange: (
    previous: PageFootprint,
    next: PageFootprint,
  ) => void;
  #values: NumericArray | undefined;
  #validity: Uint8Array | undefined;
  #dictionary: readonly string[] | undefined;
  #dictionaryHostBytes = 0;
  #resident: ResidentColumn | undefined;
  #validityResident: BitSlicedU8Column | undefined;
  pins = 0;

  constructor(
    key: string,
    definition: ColumnDefinition,
    length: number,
    storedByteLength: number,
    options: {
      readonly values?: NumericArray;
      readonly validity?: Uint8Array;
      readonly stringPage?: DictionaryStringPage;
      readonly resident?: ResidentColumn;
      readonly onFootprintChange?: (
        previous: PageFootprint,
        next: PageFootprint,
      ) => void;
    },
  ) {
    this.key = key;
    this.#definition = definition;
    this.length = length;
    this.storedByteLength = storedByteLength;
    this.#values = options.values;
    this.#validity = options.validity;
    this.#resident = options.resident;
    this.#onFootprintChange = options.onFootprintChange ?? (() => {});
    if (options.stringPage !== undefined) {
      this.#values = options.stringPage.codes;
      this.#validity = options.stringPage.validity;
      this.#dictionary = options.stringPage.dictionary;
      this.#dictionaryHostBytes = stringPageHostBytes({
        ...options.stringPage,
        codes: new Uint32Array(),
        validity: undefined,
      });
    }
    if (
      this.#resident !== undefined && definition.nullable &&
      definition.kind !== "u8"
    ) {
      this.#validityResident = validityColumn(length, this.#validity!);
      this.#validity = undefined;
    }
  }

  footprint(): PageFootprint {
    return Object.freeze({
      hostBytes: (this.#values?.byteLength ?? 0) + (this.#validity?.byteLength ?? 0) +
        this.#dictionaryHostBytes,
      wasmBytes: residentBytes(this.#resident) + (this.#validityResident?.encodedBytes ?? 0),
    });
  }

  scan(predicate: Predicate, output: SelectionMask): void {
    const resident = this.#ensureResident();
    if (predicate.operator === "is-null" || predicate.operator === "is-not-null") {
      if (!this.#definition.nullable) {
        if (predicate.operator === "is-null") output.clear();
        else output.fill();
        return;
      }
      if (this.#definition.kind === "u8") {
        resident.scanBetween(0, 2 ** this.#definition.bitWidth, output);
      } else {
        this.#validityResident!.scanEq(0, output);
      }
      if (predicate.operator === "is-null") output.invert();
      return;
    }
    if (this.#definition.kind === "string") {
      const dictionary = this.#dictionary!;
      if (typeof predicate.minimum !== "string") {
        throw new TypeError("string predicate requires a string");
      }
      const minimum = lowerBound(dictionary, predicate.minimum);
      if (predicate.operator === "eq") {
        if (dictionary[minimum] !== predicate.minimum) {
          output.clear();
          return;
        }
        resident.scanEq(minimum, output);
      } else if (predicate.operator === "lt") {
        resident.scanLt(minimum, output);
      } else {
        if (typeof predicate.maximum !== "string") {
          throw new TypeError("string between predicate requires string bounds");
        }
        resident.scanBetween(minimum, lowerBound(dictionary, predicate.maximum), output);
      }
    } else {
      if (typeof predicate.minimum !== "number") {
        throw new TypeError("numeric predicate requires a number");
      }
      if (predicate.operator === "eq") resident.scanEq(predicate.minimum, output);
      else if (predicate.operator === "lt") resident.scanLt(predicate.minimum, output);
      else resident.scanBetween(predicate.minimum, predicate.maximum as number, output);
    }
    if (this.#validityResident !== undefined) {
      using validity = new SelectionMask(this.length);
      this.#validityResident.scanEq(0, validity);
      output.andAssign(validity);
    }
  }

  gather(selection: SelectionMask): ColumnChunk {
    const count = selection.countOnes();
    const resident = this.#ensureResident();
    if (this.#definition.kind === "string") {
      const codes = new Uint32Array(count);
      const validity = this.#definition.nullable ? new Uint8Array(count) : undefined;
      (resident as AdaptiveU32Column).gatherInto(selection, codes);
      this.#gatherValidity(selection, validity);
      const output: (string | null)[] = new Array(count);
      for (let index = 0; index < count; index++) {
        output[index] = validity !== undefined && validity[index] === 0
          ? null
          : this.#dictionary![codes[index]!]!;
      }
      return output;
    }
    const output = newTypedArray(this.#definition, count);
    const validity = this.#definition.nullable ? new Uint8Array(count) : undefined;
    if (this.#definition.kind === "i32") {
      (resident as AdaptiveI32Column).gatherInto(selection, output as Int32Array);
    } else if (this.#definition.kind === "u32") {
      (resident as AdaptiveU32Column).gatherInto(selection, output as Uint32Array);
    } else {
      (resident as BitSlicedU8Column).gatherInto(
        selection,
        output as Uint8Array,
        validity,
      );
    }
    if (this.#definition.kind !== "u8") this.#gatherValidity(selection, validity);
    return validity === undefined ? output : Object.freeze({ values: output, validity });
  }

  [Symbol.dispose](): void {
    this.#resident?.[Symbol.dispose]();
    this.#resident = undefined;
    this.#validityResident?.[Symbol.dispose]();
    this.#validityResident = undefined;
    this.#values = undefined;
    this.#validity = undefined;
    this.#dictionary = undefined;
    this.#dictionaryHostBytes = 0;
  }

  #ensureResident(): ResidentColumn {
    if (this.#resident !== undefined) return this.#resident;
    const previous = this.footprint();
    if (this.#definition.kind === "i32") {
      this.#resident = AdaptiveI32Column.from(this.#values as Int32Array);
    } else if (this.#definition.kind === "u32" || this.#definition.kind === "string") {
      this.#resident = AdaptiveU32Column.from(this.#values as Uint32Array);
    } else {
      this.#resident = BitSlicedU8Column.from(
        this.#values as Uint8Array,
        this.#definition.bitWidth,
        this.#validity,
      );
    }
    if (
      this.#definition.nullable && this.#definition.kind !== "u8" &&
      this.#validityResident === undefined
    ) {
      this.#validityResident = validityColumn(this.length, this.#validity!);
    }
    this.#values = undefined;
    this.#validity = undefined;
    this.#onFootprintChange(previous, this.footprint());
    return this.#resident;
  }

  #gatherValidity(selection: SelectionMask, output: Uint8Array | undefined): void {
    if (output === undefined) return;
    const resident = this.#validityResident;
    if (resident === undefined) throw new Error("nullable column is missing validity");
    resident.gatherInto(selection, new Uint8Array(output.length), output);
  }
}

interface PageLease {
  readonly page: CachedColumnPage;
  release(): void;
}

class ResidentPageCache {
  readonly #maximumBytes: number;
  readonly #pages = new Map<string, CachedColumnPage>();
  readonly #loads = new Map<string, Promise<CachedColumnPage>>();
  #hostBytes = 0;
  #wasmBytes = 0;
  #evictions = 0;

  constructor(maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
      throw new RangeError("cacheBytes must be a non-negative safe integer");
    }
    this.#maximumBytes = maximumBytes;
  }

  stats(): CacheStats {
    return Object.freeze({
      maximumBytes: this.#maximumBytes,
      hostBytes: this.#hostBytes,
      wasmBytes: this.#wasmBytes,
      totalBytes: this.#hostBytes + this.#wasmBytes,
      pages: this.#pages.size,
      evictions: this.#evictions,
    });
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
        stats.bytesRead += page.storedByteLength;
      } else {
        page = await loading;
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
    let values: NumericArray | undefined;
    let validity: Uint8Array | undefined;
    let stringPage: DictionaryStringPage | undefined;
    let resident: ResidentColumn | undefined;
    if (definition.kind === "string") {
      stringPage = decodeDictionaryStringPage(bytes, definition.nullable);
    } else {
      let inner = bytes;
      if (definition.nullable && (definition.kind !== "u8" || format === "raw")) {
        const decoded = decodeNullableStoredPage(bytes);
        inner = decoded.inner;
        validity = decoded.validity;
        if (validity.length !== expectedLength) {
          throw new RangeError(`column page ${key} validity length mismatch`);
        }
      }
      if (format === "raw") {
        values = decodeColumnPage(definition, inner);
        if (values.length !== expectedLength) {
          throw new RangeError(`column page ${key} length mismatch`);
        }
      } else {
        resident = restoreResidentColumn(definition, inner);
        if (resident.length !== expectedLength) {
          resident[Symbol.dispose]();
          throw new RangeError(`column page ${key} length mismatch`);
        }
      }
    }
    const page = new CachedColumnPage(
      key,
      definition,
      expectedLength,
      bytes.byteLength,
      {
        values,
        validity,
        stringPage,
        resident,
        onFootprintChange: (previous, next) => {
          this.#hostBytes += next.hostBytes - previous.hostBytes;
          this.#wasmBytes += next.wasmBytes - previous.wasmBytes;
          this.#evict();
        },
      },
    );
    this.#pages.set(key, page);
    const footprint = page.footprint();
    this.#hostBytes += footprint.hostBytes;
    this.#wasmBytes += footprint.wasmBytes;
    return page;
  }

  clear(prefix = ""): void {
    for (const [key, page] of this.#pages) {
      if (!key.startsWith(prefix) || page.pins !== 0) continue;
      this.#remove(key, page);
    }
  }

  [Symbol.dispose](): void {
    for (const page of this.#pages.values()) page[Symbol.dispose]();
    this.#pages.clear();
    this.#hostBytes = 0;
    this.#wasmBytes = 0;
  }

  #evict(): void {
    if (this.#hostBytes + this.#wasmBytes <= this.#maximumBytes) return;
    for (const [key, page] of this.#pages) {
      if (this.#hostBytes + this.#wasmBytes <= this.#maximumBytes) break;
      if (page.pins !== 0) continue;
      this.#remove(key, page);
      this.#evictions++;
    }
  }

  #remove(key: string, page: CachedColumnPage): void {
    this.#pages.delete(key);
    const footprint = page.footprint();
    this.#hostBytes -= footprint.hostBytes;
    this.#wasmBytes -= footprint.wasmBytes;
    page[Symbol.dispose]();
  }
}

export type PageFormat = "raw" | "snapshot" | "dictionary";

export class SchemaEngine<Schema extends SchemaDefinition> {
  readonly schema: Schema;
  readonly backend: PageBackend;
  readonly #cache: ResidentPageCache;
  readonly #manifests = new Map<string, TableManifest>();
  readonly #manifestPins = new Map<string, Disposable>();
  readonly #pageFormat: Exclude<PageFormat, "dictionary">;
  #disposed = false;

  constructor(
    schema: Schema,
    backend: PageBackend,
    options: {
      readonly cacheBytes?: number;
      readonly pageFormat?: Exclude<PageFormat, "dictionary">;
    } = {},
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
        const pageInput = sliceColumnInput(
          definition,
          (input as Readonly<Record<string, unknown>>)[columnName],
          rowOffset,
          pageLength,
        );
        const bytes = encodeStoredColumn(definition, pageInput, this.#pageFormat);
        const key = `tables/${name}/pages/${generation}/${index}/${columnName}.bin`;
        await this.backend.put(key, bytes);
        const [minimum, maximum, nullCount] = minMax(definition, pageInput);
        columns[columnName] = Object.freeze({
          key,
          kind: definition.kind,
          format: definition.kind === "string" ? "dictionary" : this.#pageFormat,
          min: minimum,
          max: maximum,
          nullCount,
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
    const definitions = Object.fromEntries(
      Object.entries(table.columns).map(([columnName, definition]) => [
        columnName,
        storedDefinition(definition),
      ]),
    );
    const manifest: TableManifest = Object.freeze({
      version: MANIFEST_VERSION,
      generation,
      fingerprint: schemaFingerprint(table),
      definitions: Object.freeze(definitions),
      rowCount: length,
      rowGroupSize: table.rowGroupSize,
      rowGroups: Object.freeze(rowGroups),
    });
    await this.backend.put(manifestKey(name), textEncoder.encode(JSON.stringify(manifest)));
    this.#setManifest(name, manifest);
    this.#cache.clear(`tables/${name}/pages/`);
  }

  /** Publishes replacements for selected immutable column pages without rewriting other pages. */
  async updateRowGroups<Name extends TableName<Schema>>(
    name: Name,
    updates: readonly RowGroupUpdate<Schema["tables"][Name]>[],
  ): Promise<void> {
    this.#assertAlive();
    if (!Array.isArray(updates) || updates.length === 0) {
      throw new RangeError("row-group updates must not be empty");
    }
    const table = this.#table(name);
    const current = await this.#manifest(name, table);
    const generation = `${Date.now()}-${crypto.randomUUID()}`;
    const seen = new Set<number>();
    const planned: {
      readonly index: number;
      readonly columns: readonly {
        readonly name: string;
        readonly bytes: Uint8Array;
        readonly metadata: ColumnManifest;
      }[];
    }[] = [];

    for (const update of updates) {
      if (
        typeof update !== "object" || update === null || !Number.isSafeInteger(update.index) ||
        update.index < 0 || update.index >= current.rowGroups.length
      ) {
        throw new RangeError("row-group update index is out of range");
      }
      if (seen.has(update.index)) throw new RangeError("row-group update indices must be unique");
      seen.add(update.index);
      if (typeof update.columns !== "object" || update.columns === null) {
        throw new TypeError("row-group update columns must be an object");
      }
      const entries = Object.entries(update.columns);
      if (entries.length === 0) throw new RangeError("row-group update columns must not be empty");
      const group = current.rowGroups[update.index]!;
      const columns = entries.map(([columnName, input]) => {
        const definition = table.columns[columnName];
        if (definition === undefined) throw new RangeError(`unknown column ${columnName}`);
        const length = validateColumnInput(columnName, definition, input);
        if (length !== group.length) {
          throw new RangeError(
            `row-group column ${columnName} must contain exactly ${group.length} values`,
          );
        }
        const bytes = encodeStoredColumn(definition, input, this.#pageFormat);
        const key = `tables/${name}/pages/${generation}/${update.index}/${columnName}.bin`;
        const [minimum, maximum, nullCount] = minMax(definition, input);
        return Object.freeze({
          name: columnName,
          bytes,
          metadata: Object.freeze({
            key,
            kind: definition.kind,
            format: definition.kind === "string" ? "dictionary" : this.#pageFormat,
            min: minimum,
            max: maximum,
            nullCount,
            byteLength: bytes.byteLength,
          }),
        });
      });
      planned.push(Object.freeze({ index: update.index, columns: Object.freeze(columns) }));
    }

    const rowGroups = current.rowGroups.slice();
    for (const update of planned) {
      const currentGroup = current.rowGroups[update.index]!;
      const columns: Record<string, ColumnManifest> = { ...currentGroup.columns };
      for (const column of update.columns) {
        await this.backend.put(column.metadata.key, column.bytes);
        columns[column.name] = column.metadata;
      }
      rowGroups[update.index] = Object.freeze({
        ...currentGroup,
        columns: Object.freeze(columns),
      });
    }

    const definitions = Object.fromEntries(
      Object.entries(table.columns).map(([columnName, definition]) => [
        columnName,
        storedDefinition(definition),
      ]),
    );
    const manifest: TableManifest = Object.freeze({
      version: MANIFEST_VERSION,
      generation,
      fingerprint: schemaFingerprint(table),
      definitions: Object.freeze(definitions),
      rowCount: current.rowCount,
      rowGroupSize: current.rowGroupSize,
      rowGroups: Object.freeze(rowGroups),
    });
    await this.backend.put(manifestKey(name), textEncoder.encode(JSON.stringify(manifest)));
    this.#setManifest(name, manifest);
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

  cacheStats(): CacheStats {
    this.#assertAlive();
    return this.#cache.stats();
  }

  /**
   * Reads a non-nullable i32 column in its persisted snapshot representation.
   *
   * This bypasses the resident cache so a physical executor can copy compressed immutable pages
   * directly into shared memory without first reconstructing a complete host or Wasm column.
   */
  async readI32SnapshotPages<Name extends TableName<Schema>>(
    name: Name,
    columnName: ColumnName<Schema["tables"][Name]>,
  ): Promise<I32SnapshotPages> {
    this.#assertAlive();
    const table = this.#table(name);
    const definition = table.columns[columnName];
    if (definition === undefined) throw new RangeError(`unknown column ${columnName}`);
    if (definition.kind !== "i32" || definition.nullable) {
      throw new TypeError("shared i32 snapshots require a non-nullable i32 column");
    }
    const manifest = await this.#manifest(name, table);
    using _pin = acquireVersionedRowGroupPin(this.backend, name, manifest);
    const pages = await Promise.all(manifest.rowGroups.map(async (group) => {
      const metadata = group.columns[columnName];
      if (metadata === undefined) {
        throw new TypeError("shared i32 snapshots do not support virtual default pages");
      }
      if (
        metadata.kind !== "i32" || metadata.format !== "snapshot" ||
        metadata.nullCount !== 0 || typeof metadata.min !== "number" ||
        typeof metadata.max !== "number"
      ) {
        throw new TypeError("column page is not a non-nullable i32 snapshot");
      }
      const bytes = await this.backend.get(metadata.key);
      if (bytes === undefined) throw new Error(`missing page ${metadata.key}`);
      if (bytes.byteLength !== metadata.byteLength) {
        throw new RangeError(`page ${metadata.key} has an incorrect byte length`);
      }
      return Object.freeze({
        index: group.index,
        rowOffset: group.rowOffset,
        length: group.length,
        min: metadata.min,
        max: metadata.max,
        byteLength: metadata.byteLength,
        bytes,
      });
    }));
    return Object.freeze({
      generation: manifest.generation,
      rowCount: manifest.rowCount,
      rowGroupSize: manifest.rowGroupSize,
      bytesRead: pages.reduce((sum, page) => sum + page.byteLength, 0),
      pages: Object.freeze(pages),
    });
  }

  /** Reloads a table manifest published by another engine and drops its resident pages. */
  async refresh<Name extends TableName<Schema>>(name: Name): Promise<void> {
    this.#assertAlive();
    const table = this.#table(name);
    const manifest = await this.#readManifest(name, table);
    this.#setManifest(name, manifest);
    this.#cache.clear(`tables/${name}/pages/`);
  }

  async vacuum<Name extends TableName<Schema>>(name: Name): Promise<number> {
    this.#assertAlive();
    const manifest = await this.#manifest(name, this.#table(name));
    const prefix = `tables/${name}/pages/`;
    const live = pinnedVersionedRowGroupPageKeys(this.backend, name);
    for (const group of manifest.rowGroups) {
      for (const column of Object.values(group.columns)) live.add(column.key);
    }
    const obsolete = (await this.backend.list(prefix)).filter((key) => !live.has(key));
    await Promise.all(obsolete.map((key) => this.backend.delete(key)));
    this.#cache.clear(prefix);
    return obsolete.length;
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cache[Symbol.dispose]();
    for (const pin of this.#manifestPins.values()) pin[Symbol.dispose]();
    this.#manifestPins.clear();
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
    using _pin = acquireVersionedRowGroupPin(this.backend, tableName, manifest);
    const stats: MutableStats = {
      rowGroupsTotal: manifest.rowGroups.length,
      rowGroupsSkipped: 0,
      pagesRead: 0,
      cacheHits: 0,
      bytesRead: 0,
      rowsMatched: 0,
    };
    const rowIdChunks: Uint32Array[] = [];
    const chunks = new Map<string, ColumnChunk[]>();
    for (const name of selected) chunks.set(name, []);

    for (const group of manifest.rowGroups) {
      if (
        predicates.some((predicate) => {
          const definition = table.columns[predicate.column]!;
          const metadata = group.columns[predicate.column];
          return metadata === undefined
            ? !defaultMayMatch(definition, predicate)
            : !mayMatch(metadata, group.length, predicate);
        })
      ) {
        stats.rowGroupsSkipped++;
        continue;
      }
      const needed = new Set<string>(predicates.map((predicate) => predicate.column));
      if (materialize) { for (const name of selected) needed.add(name); }
      const leases = new Map<string, PageLease>();
      try {
        await Promise.all(Array.from(needed, async (columnName) => {
          const definition = table.columns[columnName];
          if (definition === undefined) throw new RangeError(`unknown column ${columnName}`);
          const metadata = group.columns[columnName];
          if (metadata === undefined) {
            const page = virtualDefaultPage(columnName, definition, group.length);
            leases.set(columnName, {
              page,
              release: () => page[Symbol.dispose](),
            });
            return;
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
          leases.get(predicate.column)!.page.scan(predicate, temporary);
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
          chunks.get(columnName)!.push(leases.get(columnName)!.page.gather(selection));
        }
      } finally {
        for (const lease of leases.values()) lease.release();
      }
    }

    const frozenStats = Object.freeze({ ...stats });
    if (!materialize) return Object.freeze({ value: stats.rowsMatched, stats: frozenStats });
    const columns: Record<string, ColumnChunk> = {};
    for (const columnName of selected) {
      columns[columnName] = concatenate(
        table.columns[columnName]!,
        chunks.get(columnName)!,
      );
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
    this.#setManifest(name, manifest);
    return manifest;
  }

  #setManifest(name: string, manifest: TableManifest): void {
    const previous = this.#manifests.get(name);
    if (previous?.generation === manifest.generation) {
      this.#manifests.set(name, manifest);
      return;
    }
    const pin = acquireVersionedRowGroupPin(this.backend, name, manifest);
    this.#manifestPins.get(name)?.[Symbol.dispose]();
    this.#manifestPins.set(name, pin);
    this.#manifests.set(name, manifest);
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
    validateSchemaEvolution(table, manifest, name);
    return manifest;
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("SchemaEngine has been disposed");
  }
}

type PredicateValue<Definition extends ColumnDefinition> = Definition["kind"] extends "string"
  ? string
  : number;

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
    value: PredicateValue<Table["columns"][Name]>,
  ): QueryBuilder<Table, Selected, Schema>;
  where<Name extends ColumnName<Table>>(
    column: Name,
    operator: "between",
    minimum: PredicateValue<Table["columns"][Name]>,
    maximum: PredicateValue<Table["columns"][Name]>,
  ): QueryBuilder<Table, Selected, Schema>;
  where<Name extends ColumnName<Table>>(
    column: Name,
    operator: PredicateOperator,
    minimum: Scalar,
    maximum?: Scalar,
  ): QueryBuilder<Table, Selected, Schema> {
    const definition = this.#table.columns[column];
    if (definition === undefined) throw new RangeError(`unknown column ${column}`);
    validatePredicateValue(definition, minimum);
    if (operator === "between") {
      if (maximum === undefined) throw new TypeError("between requires a maximum");
      validatePredicateValue(definition, maximum);
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

  whereNull<Name extends ColumnName<Table>>(
    column: Name,
  ): QueryBuilder<Table, Selected, Schema> {
    return this.#whereValidity(column, "is-null");
  }

  whereNotNull<Name extends ColumnName<Table>>(
    column: Name,
  ): QueryBuilder<Table, Selected, Schema> {
    return this.#whereValidity(column, "is-not-null");
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

  #whereValidity(
    column: ColumnName<Table>,
    operator: "is-null" | "is-not-null",
  ): QueryBuilder<Table, Selected, Schema> {
    if (this.#table.columns[column] === undefined) throw new RangeError(`unknown column ${column}`);
    return new QueryBuilder(
      this.#engine,
      this.#tableName,
      this.#table,
      [...this.#predicates, Object.freeze({ column, operator })],
      this.#selected,
    );
  }
}

function encodeStoredColumn(
  definition: ColumnDefinition,
  input: unknown,
  format: Exclude<PageFormat, "dictionary">,
): Uint8Array {
  if (definition.kind === "string") {
    return encodeDictionaryStringPage(
      input as readonly (string | null)[],
      definition.nullable,
    );
  }
  const { values, validity } = numericParts(definition, input);
  const inner = format === "raw"
    ? encodeColumnPage(definition, values)
    : serializeResidentColumn(definition, values, validity);
  return definition.nullable && (definition.kind !== "u8" || format === "raw")
    ? encodeNullableStoredPage(inner, validity!)
    : inner;
}

function serializeResidentColumn(
  definition: Exclude<ColumnDefinition, { readonly kind: "string" }>,
  values: NumericArray,
  validity?: Uint8Array,
): Uint8Array {
  using resident = createResidentColumn(definition, values, validity);
  return resident.serialize();
}

function createResidentColumn(
  definition: Exclude<ColumnDefinition, { readonly kind: "string" }>,
  values: NumericArray,
  validity?: Uint8Array,
): ResidentColumn {
  if (definition.kind === "i32") return AdaptiveI32Column.from(values as Int32Array);
  if (definition.kind === "u32") return AdaptiveU32Column.from(values as Uint32Array);
  return BitSlicedU8Column.from(values as Uint8Array, definition.bitWidth, validity);
}

function restoreResidentColumn(
  definition: Exclude<ColumnDefinition, { readonly kind: "string" }>,
  snapshot: Uint8Array,
): ResidentColumn {
  if (definition.kind === "i32") return AdaptiveI32Column.fromSnapshot(snapshot);
  if (definition.kind === "u32") return AdaptiveU32Column.fromSnapshot(snapshot);
  return BitSlicedU8Column.fromSnapshot(snapshot);
}

function validityColumn(length: number, validity: Uint8Array): BitSlicedU8Column {
  return BitSlicedU8Column.from(new Uint8Array(length), 1, validity);
}

function residentBytes(resident: ResidentColumn | undefined): number {
  return resident?.encodedBytes ?? 0;
}

function mayMatch(
  metadata: ColumnManifest,
  rowCount: number,
  predicate: Predicate,
): boolean {
  if (predicate.operator === "is-null") return metadata.nullCount > 0;
  if (predicate.operator === "is-not-null") return metadata.nullCount < rowCount;
  if (metadata.min === null || metadata.max === null) return false;
  return scalarMatches(metadata.min, metadata.max, predicate);
}

function defaultMayMatch(definition: ColumnDefinition, predicate: Predicate): boolean {
  const value = defaultValue(definition);
  if (predicate.operator === "is-null") return value === null;
  if (predicate.operator === "is-not-null") return value !== null;
  return value !== null && scalarMatches(value, value, predicate);
}

function scalarMatches(minimum: Scalar, maximum: Scalar, predicate: Predicate): boolean {
  if (predicate.minimum === undefined) return false;
  if (typeof minimum !== typeof predicate.minimum) return false;
  if (predicate.operator === "eq") {
    return compare(predicate.minimum, minimum) >= 0 && compare(predicate.minimum, maximum) <= 0;
  }
  if (predicate.operator === "lt") return compare(minimum, predicate.minimum) < 0;
  return compare(predicate.minimum, predicate.maximum!) < 0 &&
    compare(maximum, predicate.minimum) >= 0 &&
    compare(minimum, predicate.maximum!) < 0;
}

function validateTableInput(table: TableDefinition, input: object): number {
  let length: number | undefined;
  for (const [name, definition] of Object.entries(table.columns)) {
    const value = (input as Readonly<Record<string, unknown>>)[name];
    const columnLength = validateColumnInput(name, definition, value);
    if (length === undefined) length = columnLength;
    else if (length !== columnLength) throw new RangeError("all columns must have equal length");
  }
  return length ?? 0;
}

function validateColumnInput(
  name: string,
  definition: ColumnDefinition,
  input: unknown,
): number {
  if (definition.kind === "string") {
    if (!Array.isArray(input)) throw new TypeError(`column ${name} must be an Array`);
    for (const item of input) {
      if (typeof item !== "string" && !(definition.nullable && item === null)) {
        throw new TypeError(`column ${name} contains an invalid string value`);
      }
    }
    return input.length;
  }
  const { values, validity } = numericParts(definition, input);
  const valid = definition.kind === "i32"
    ? values instanceof Int32Array
    : definition.kind === "u32"
    ? values instanceof Uint32Array
    : values instanceof Uint8Array;
  if (!valid) throw new TypeError(`column ${name} must be a ${typedArrayName(definition)}`);
  if (definition.nullable) {
    if (!(validity instanceof Uint8Array) || validity.length !== values.length) {
      throw new RangeError(`column ${name} validity must have one byte per value`);
    }
  }
  if (definition.kind === "u8") {
    const limit = 2 ** definition.bitWidth;
    for (let index = 0; index < values.length; index++) {
      if (validity !== undefined && validity[index] === 0) continue;
      if (values[index]! >= limit) {
        throw new RangeError(`column ${name} contains a value outside its bit width`);
      }
    }
  }
  return values.length;
}

function numericParts(
  definition: Exclude<ColumnDefinition, { readonly kind: "string" }>,
  input: unknown,
): { readonly values: NumericArray; readonly validity: Uint8Array | undefined } {
  if (!definition.nullable) {
    return { values: input as NumericArray, validity: undefined };
  }
  if (typeof input !== "object" || input === null) {
    throw new TypeError("nullable numeric input requires values and validity");
  }
  const candidate = input as Partial<NullableColumn<NumericArray>>;
  return { values: candidate.values as NumericArray, validity: candidate.validity };
}

function sliceColumnInput(
  definition: ColumnDefinition,
  input: unknown,
  offset: number,
  length: number,
): unknown {
  if (definition.kind === "string") {
    return (input as readonly (string | null)[]).slice(offset, offset + length);
  }
  const parts = numericParts(definition, input);
  const values = parts.values.slice(offset, offset + length) as NumericArray;
  if (!definition.nullable) return values;
  return Object.freeze({
    values,
    validity: parts.validity!.slice(offset, offset + length),
  });
}

function typedArrayName(
  definition: Exclude<ColumnDefinition, { readonly kind: "string" }>,
): string {
  if (definition.kind === "i32") return "Int32Array";
  if (definition.kind === "u32") return "Uint32Array";
  return "Uint8Array";
}

function minMax(
  definition: ColumnDefinition,
  input: unknown,
): readonly [Scalar | null, Scalar | null, number] {
  if (definition.kind === "string") {
    const values = input as readonly (string | null)[];
    let minimum: string | null = null;
    let maximum: string | null = null;
    let nullCount = 0;
    for (const value of values) {
      if (value === null) {
        nullCount++;
        continue;
      }
      if (minimum === null || value < minimum) minimum = value;
      if (maximum === null || value > maximum) maximum = value;
    }
    return [minimum, maximum, nullCount];
  }
  const { values, validity } = numericParts(definition, input);
  let minimum: number | null = null;
  let maximum: number | null = null;
  let nullCount = 0;
  for (let index = 0; index < values.length; index++) {
    if (validity !== undefined && validity[index] === 0) {
      nullCount++;
      continue;
    }
    const value = values[index]!;
    if (minimum === null || value < minimum) minimum = value;
    if (maximum === null || value > maximum) maximum = value;
  }
  return [minimum, maximum, nullCount];
}

function newTypedArray(
  definition: Exclude<ColumnDefinition, { readonly kind: "string" }>,
  length: number,
): NumericArray {
  if (definition.kind === "i32") return new Int32Array(length);
  if (definition.kind === "u32") return new Uint32Array(length);
  return new Uint8Array(length);
}

function concatenate(
  definition: ColumnDefinition,
  chunks: readonly ColumnChunk[],
): ColumnChunk {
  if (definition.kind === "string") {
    const output: (string | null)[] = [];
    for (const chunk of chunks) output.push(...chunk as readonly (string | null)[]);
    return output;
  }
  if (definition.nullable) {
    const nullableChunks = chunks as readonly NullableColumn<NumericArray>[];
    const values = concatenateNumeric(
      definition,
      nullableChunks.map((chunk) => chunk.values),
    );
    const validity = concatenateBytes(nullableChunks.map((chunk) => chunk.validity));
    return Object.freeze({ values, validity });
  }
  return concatenateNumeric(definition, chunks as readonly NumericArray[]);
}

function concatenateNumeric(
  definition: Exclude<ColumnDefinition, { readonly kind: "string" }>,
  chunks: readonly NumericArray[],
): NumericArray {
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

function concatenateBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const output = new Uint8Array(length);
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

function virtualDefaultPage(
  key: string,
  definition: ColumnDefinition,
  length: number,
): CachedColumnPage {
  const value = defaultValue(definition);
  if (definition.kind === "string") {
    return new CachedColumnPage(key, definition, length, 0, {
      stringPage: decodeDictionaryStringPage(
        encodeDictionaryStringPage(
          Array.from({ length }, () => value as string | null),
          definition.nullable,
        ),
        definition.nullable,
      ),
    });
  }
  const values = newTypedArray(definition, length);
  const validity = definition.nullable ? new Uint8Array(length) : undefined;
  if (value !== null) {
    values.fill(value as number);
    validity?.fill(1);
  }
  return new CachedColumnPage(key, definition, length, 0, { values, validity });
}

function defaultValue(definition: ColumnDefinition): Scalar | null {
  if (Object.hasOwn(definition, "default")) return definition.default ?? null;
  if (definition.nullable) return null;
  throw new RangeError("added non-nullable columns require a default");
}

function storedDefinition(definition: ColumnDefinition): StoredColumnDefinition {
  return Object.freeze({
    kind: definition.kind,
    nullable: definition.nullable,
    ...(definition.kind === "u8" ? { bitWidth: definition.bitWidth } : {}),
  });
}

function validateSchemaEvolution(
  table: TableDefinition,
  manifest: TableManifest,
  tableName: string,
): void {
  if (manifest.rowGroupSize !== table.rowGroupSize) {
    throw new RangeError(`schema mismatch for table ${tableName}: rowGroupSize changed`);
  }
  for (const [name, stored] of Object.entries(manifest.definitions)) {
    const current = table.columns[name];
    if (
      current === undefined || current.kind !== stored.kind ||
      current.nullable !== stored.nullable ||
      (current.kind === "u8" && current.bitWidth !== stored.bitWidth)
    ) {
      throw new RangeError(`schema mismatch for table ${tableName}: column ${name} changed`);
    }
  }
  for (const [name, current] of Object.entries(table.columns)) {
    if (manifest.definitions[name] !== undefined) continue;
    if (!current.nullable && !Object.hasOwn(current, "default")) {
      throw new RangeError(
        `schema mismatch for table ${tableName}: added column ${name} requires a default`,
      );
    }
  }
}

function validatePredicateValue(definition: ColumnDefinition, value: Scalar): void {
  if (definition.kind === "string") {
    if (typeof value !== "string") throw new TypeError("string predicate values must be strings");
  } else if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new RangeError("numeric predicate values must be safe integers");
  }
}

function compare(left: Scalar, right: Scalar): number {
  if (typeof left !== typeof right) return Number.NaN;
  return left < right ? -1 : left > right ? 1 : 0;
}

function lowerBound(values: readonly string[], target: string): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function manifestKey(name: string): string {
  return `tables/${name}/manifest.json`;
}

function validateManifest(value: unknown): TableManifest {
  if (typeof value !== "object" || value === null) throw new RangeError("invalid table manifest");
  const candidate = value as Partial<TableManifest>;
  if (
    candidate.version !== MANIFEST_VERSION || typeof candidate.generation !== "string" ||
    typeof candidate.fingerprint !== "string" ||
    typeof candidate.definitions !== "object" || candidate.definitions === null ||
    !Number.isSafeInteger(candidate.rowCount) ||
    !Number.isSafeInteger(candidate.rowGroupSize) || !Array.isArray(candidate.rowGroups)
  ) {
    throw new RangeError("invalid table manifest");
  }
  for (const definition of Object.values(candidate.definitions)) {
    if (!validStoredDefinition(definition)) throw new RangeError("invalid stored schema");
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
        typeof column.kind !== "string" ||
        !["i32", "u32", "u8", "string"].includes(column.kind) ||
        typeof column.format !== "string" ||
        !["raw", "snapshot", "dictionary"].includes(column.format) ||
        !validScalarOrNull(column.min) || !validScalarOrNull(column.max) ||
        !Number.isSafeInteger(column.nullCount) ||
        !Number.isSafeInteger(column.byteLength)
      ) throw new RangeError("invalid column manifest");
    }
  }
  return candidate as TableManifest;
}

function validStoredDefinition(value: unknown): value is StoredColumnDefinition {
  if (typeof value !== "object" || value === null) return false;
  const definition = value as Partial<StoredColumnDefinition>;
  if (
    typeof definition.kind !== "string" ||
    !["i32", "u32", "u8", "string"].includes(definition.kind) ||
    typeof definition.nullable !== "boolean"
  ) return false;
  return definition.kind !== "u8" ||
    (Number.isInteger(definition.bitWidth) && definition.bitWidth! >= 1 &&
      definition.bitWidth! <= 8);
}

function validScalarOrNull(value: unknown): value is Scalar | null {
  return value === null || typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value));
}
