export interface VersionedPageReference {
  readonly key: string;
}

export interface VersionedRowGroupReference {
  readonly columns: Readonly<Record<string, VersionedPageReference>>;
}

export interface VersionedRowGroupManifest {
  readonly generation: string;
  readonly rowGroups: readonly VersionedRowGroupReference[];
}

interface PinRecord {
  readonly manifest: VersionedRowGroupManifest;
  count: number;
}

const pins = new WeakMap<object, Map<string, Map<string, PinRecord>>>();

/** Pins immutable pages referenced by one observed table generation. */
export function acquireVersionedRowGroupPin(
  backend: object,
  table: string,
  manifest: VersionedRowGroupManifest,
): Disposable {
  let tables = pins.get(backend);
  if (tables === undefined) {
    tables = new Map();
    pins.set(backend, tables);
  }
  let generations = tables.get(table);
  if (generations === undefined) {
    generations = new Map();
    tables.set(table, generations);
  }
  let record = generations.get(manifest.generation);
  if (record === undefined) {
    record = { manifest, count: 0 };
    generations.set(manifest.generation, record);
  }
  record.count++;
  return new VersionedRowGroupPin(backend, table, manifest.generation);
}

/** Returns every immutable page protected by an observed generation. */
export function pinnedVersionedRowGroupPageKeys(backend: object, table: string): Set<string> {
  const keys = new Set<string>();
  const generations = pins.get(backend)?.get(table);
  if (generations === undefined) return keys;
  for (const record of generations.values()) {
    for (const group of record.manifest.rowGroups) {
      for (const column of Object.values(group.columns)) keys.add(column.key);
    }
  }
  return keys;
}

class VersionedRowGroupPin implements Disposable {
  readonly #backend: object;
  readonly #table: string;
  readonly #generation: string;
  #disposed = false;

  constructor(backend: object, table: string, generation: string) {
    this.#backend = backend;
    this.#table = table;
    this.#generation = generation;
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const tables = pins.get(this.#backend);
    const generations = tables?.get(this.#table);
    const record = generations?.get(this.#generation);
    if (record === undefined || record.count <= 0) {
      throw new Error("invalid versioned row-group pin state");
    }
    record.count--;
    if (record.count !== 0) return;
    generations!.delete(this.#generation);
    if (generations!.size === 0) tables!.delete(this.#table);
  }
}
