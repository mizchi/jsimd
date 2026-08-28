import { SharedBuffer } from "@mizchi/jsimd-shared";
import { instantiateQueryKernels, type QueryKernels } from "./kernel.ts";
import { type LocalGroupEntryU32, LocalGroupHashTableU32 } from "./local_group_hash_table.ts";
import {
  type LocalGroupHashScanResult,
  LocalGroupHashWorkerPool,
} from "./local_group_hash_worker_pool.ts";

export interface SparseU32GroupByColumns {
  readonly filter: Int32Array;
  readonly keys: Uint32Array;
  readonly values: Int32Array;
  readonly validities: Uint8Array;
}

export interface SparseU32GroupByOptions {
  readonly capacity: number;
  readonly workerCount?: number;
  readonly pageRows?: number;
}

export interface SparseU32GroupByResult extends LocalGroupHashScanResult {
  readonly groups: readonly LocalGroupEntryU32[];
}

interface Page {
  readonly rowStart: number;
  readonly rowCount: number;
  readonly minimum: number;
  readonly maximum: number;
}

/** Experimental immutable filtered sparse-u32 group-by query. */
export class SparseU32GroupByQuery implements AsyncDisposable {
  readonly workerCount: number;
  readonly pageRows: number;
  readonly #shared: SharedBuffer;
  readonly #kernels: QueryKernels;
  readonly #single: LocalGroupHashTableU32 | null;
  readonly #outputs: readonly LocalGroupHashTableU32[];
  readonly #pool: LocalGroupHashWorkerPool | null;
  readonly #pages: readonly Page[];
  readonly #filterOffset: number;
  readonly #keysOffset: number;
  readonly #valuesOffset: number;
  readonly #validitiesOffset: number;
  #disposed = false;

  private constructor(
    shared: SharedBuffer,
    kernels: QueryKernels,
    workerCount: number,
    pageRows: number,
    single: LocalGroupHashTableU32 | null,
    outputs: readonly LocalGroupHashTableU32[],
    pool: LocalGroupHashWorkerPool | null,
    pages: readonly Page[],
    filterOffset: number,
    keysOffset: number,
    valuesOffset: number,
    validitiesOffset: number,
  ) {
    this.#shared = shared;
    this.#kernels = kernels;
    this.workerCount = workerCount;
    this.pageRows = pageRows;
    this.#single = single;
    this.#outputs = outputs;
    this.#pool = pool;
    this.#pages = pages;
    this.#filterOffset = filterOffset;
    this.#keysOffset = keysOffset;
    this.#valuesOffset = valuesOffset;
    this.#validitiesOffset = validitiesOffset;
  }

  static async create(
    columns: SparseU32GroupByColumns,
    options: SparseU32GroupByOptions,
  ): Promise<SparseU32GroupByQuery> {
    validateColumns(columns);
    const workerCount = positiveInteger(options.workerCount ?? 1, "workerCount");
    if (workerCount !== 1 && (workerCount & (workerCount - 1)) !== 0) {
      throw new RangeError("workerCount must be one or a power of two");
    }
    const pageRows = positiveInteger(options.pageRows ?? 65_536, "pageRows");
    const stride = LocalGroupHashTableU32.byteLengthFor(options.capacity);
    const tableCount = workerCount === 1 ? 1 : workerCount * 2;
    const filterOffset = stride * tableCount;
    const keysOffset = filterOffset + columns.filter.byteLength;
    const valuesOffset = keysOffset + columns.keys.byteLength;
    const validitiesOffset = valuesOffset + columns.values.byteLength;
    const requiredBytes = validitiesOffset + columns.validities.byteLength;
    const initialPages = Math.ceil((requiredBytes + 65_535) / 65_536);
    const shared = await SharedBuffer.create({
      initialPages,
      maximumPages: initialPages,
      maxWorkers: workerCount + 1,
    });
    let pool: LocalGroupHashWorkerPool | null = null;
    try {
      const kernels = await instantiateQueryKernels(shared.memory);
      shared.int32Array(filterOffset, columns.filter.length).set(columns.filter);
      shared.uint32Array(keysOffset, columns.keys.length).set(columns.keys);
      shared.int32Array(valuesOffset, columns.values.length).set(columns.values);
      shared.uint8Array(validitiesOffset, columns.validities.length).set(columns.validities);
      const pages = createPages(columns.filter, pageRows);
      if (workerCount === 1) {
        const single = LocalGroupHashTableU32.initialize(shared, 0, options.capacity);
        return new SparseU32GroupByQuery(
          shared,
          kernels,
          workerCount,
          pageRows,
          single,
          [single],
          null,
          pages,
          filterOffset,
          keysOffset,
          valuesOffset,
          validitiesOffset,
        );
      }
      const partials = Array.from(
        { length: workerCount },
        (_, index) => LocalGroupHashTableU32.initialize(shared, stride * index, options.capacity),
      );
      const outputs = Array.from(
        { length: workerCount },
        (_, index) =>
          LocalGroupHashTableU32.initialize(
            shared,
            stride * (workerCount + index),
            options.capacity,
          ),
      );
      pool = await LocalGroupHashWorkerPool.create(shared, partials, outputs, {
        filterByteOffset: filterOffset,
        keysByteOffset: keysOffset,
        valuesByteOffset: valuesOffset,
        validitiesByteOffset: validitiesOffset,
        rowCount: columns.filter.length,
        pageRows,
      });
      return new SparseU32GroupByQuery(
        shared,
        kernels,
        workerCount,
        pageRows,
        null,
        outputs,
        pool,
        pages,
        filterOffset,
        keysOffset,
        valuesOffset,
        validitiesOffset,
      );
    } catch (error) {
      await pool?.[Symbol.asyncDispose]();
      shared[Symbol.dispose]();
      throw error;
    }
  }

  async aggregateBetween(minimum: number, maximum: number): Promise<SparseU32GroupByResult> {
    this.#assertAlive();
    validateInt32(minimum, "minimum");
    validateInt32(maximum, "maximum");
    if (this.#pool !== null) {
      const scan = await this.#pool.aggregateBetween(minimum, maximum);
      return { ...scan, groups: materialize(this.#outputs) };
    }
    const table = this.#single!;
    table.clear();
    let pagesScanned = 0;
    let pagesSkipped = 0;
    for (const page of this.#pages) {
      if (minimum >= maximum || maximum <= page.minimum || minimum > page.maximum) {
        pagesSkipped++;
        continue;
      }
      table.aggregateResidentBetween(
        this.#filterOffset + page.rowStart * 4,
        this.#keysOffset + page.rowStart * 4,
        this.#valuesOffset + page.rowStart * 4,
        this.#validitiesOffset + page.rowStart,
        page.rowCount,
        minimum,
        maximum,
        this.#kernels,
      );
      pagesScanned++;
    }
    return { pagesScanned, pagesSkipped, groups: materialize([table]) };
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.#pool?.[Symbol.asyncDispose]();
    this.#shared[Symbol.dispose]();
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("SparseU32GroupByQuery has been disposed");
  }
}

function materialize(tables: readonly LocalGroupHashTableU32[]): LocalGroupEntryU32[] {
  return tables.flatMap((table) => table.entries()).sort((left, right) => left.key - right.key);
}

function createPages(filter: Int32Array, pageRows: number): Page[] {
  const pages: Page[] = [];
  for (let rowStart = 0; rowStart < filter.length; rowStart += pageRows) {
    const rowCount = Math.min(pageRows, filter.length - rowStart);
    let minimum = 0x7fff_ffff;
    let maximum = -0x8000_0000;
    for (let row = rowStart; row < rowStart + rowCount; row++) {
      const value = filter[row]!;
      if (value < minimum) minimum = value;
      if (value > maximum) maximum = value;
    }
    pages.push({ rowStart, rowCount, minimum, maximum });
  }
  return pages;
}

function validateColumns(columns: SparseU32GroupByColumns): void {
  const length = columns.filter.length;
  if (
    columns.keys.length !== length || columns.values.length !== length ||
    columns.validities.length !== length
  ) throw new RangeError("sparse group-by columns must have equal lengths");
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function validateInt32(value: number, name: string): void {
  if (!Number.isInteger(value) || value < -0x8000_0000 || value > 0x7fff_ffff) {
    throw new RangeError(`${name} must be an i32`);
  }
}
