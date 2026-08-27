import type { PageBackend } from "./backend.ts";
import { validateKey, validatePrefix } from "./backend.ts";

interface RequestLike<Result> {
  readonly result: Result;
  readonly error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

interface ObjectStoreLike {
  get(key: string): RequestLike<ArrayBuffer | Uint8Array | undefined>;
  put(value: Uint8Array, key: string): RequestLike<unknown>;
  delete(key: string): RequestLike<unknown>;
  getAllKeys(): RequestLike<readonly unknown[]>;
}

interface TransactionLike {
  readonly error: unknown;
  oncomplete: (() => void) | null;
  onabort: (() => void) | null;
  onerror: (() => void) | null;
  objectStore(name: string): ObjectStoreLike;
}

interface DatabaseLike {
  readonly objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string): unknown;
  transaction(name: string, mode: "readonly" | "readwrite"): TransactionLike;
  close(): void;
}

interface OpenRequestLike extends RequestLike<DatabaseLike> {
  onupgradeneeded: (() => void) | null;
}

interface IndexedDbFactoryLike {
  open(name: string, version: number): OpenRequestLike;
  deleteDatabase(name: string): RequestLike<unknown>;
}

/** Browser/Deno IndexedDB backend. The database connection is closed by `using`. */
export class IndexedDbPageBackend implements PageBackend {
  readonly #database: DatabaseLike;
  readonly #storeName: string;
  #disposed = false;

  private constructor(database: DatabaseLike, storeName: string) {
    this.#database = database;
    this.#storeName = storeName;
  }

  static open(name: string, storeName = "pages"): Promise<IndexedDbPageBackend> {
    const factory = indexedDbFactory();
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName);
      }
    };
    return requestPromise(request).then((database) =>
      new IndexedDbPageBackend(database, storeName)
    );
  }

  static async deleteDatabase(name: string): Promise<void> {
    await requestPromise(indexedDbFactory().deleteDatabase(name));
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    validateKey(key);
    const value = await this.#request("readonly", (store) => store.get(key));
    if (value === undefined) return undefined;
    if (value instanceof Uint8Array) return value.slice();
    return new Uint8Array(value).slice();
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    validateKey(key);
    if (!(value instanceof Uint8Array)) throw new TypeError("page value must be a Uint8Array");
    await this.#request("readwrite", (store) => store.put(value.slice(), key));
  }

  async delete(key: string): Promise<void> {
    validateKey(key);
    await this.#request("readwrite", (store) => store.delete(key));
  }

  async list(prefix: string): Promise<readonly string[]> {
    validatePrefix(prefix);
    const keys = await this.#request("readonly", (store) => store.getAllKeys());
    return keys.filter((key): key is string => typeof key === "string" && key.startsWith(prefix))
      .sort();
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#database.close();
  }

  #request<Result>(
    mode: "readonly" | "readwrite",
    operation: (store: ObjectStoreLike) => RequestLike<Result>,
  ): Promise<Result> {
    if (this.#disposed) return Promise.reject(new Error("IndexedDB backend has been disposed"));
    const transaction = this.#database.transaction(this.#storeName, mode);
    const request = operation(transaction.objectStore(this.#storeName));
    return new Promise((resolve, reject) => {
      let result: Result;
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
      transaction.oncomplete = () => resolve(result!);
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB aborted"));
      transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB failed"));
    });
  }
}

function indexedDbFactory(): IndexedDbFactoryLike {
  const factory = (globalThis as unknown as { indexedDB?: IndexedDbFactoryLike }).indexedDB;
  if (factory === undefined) throw new Error("IndexedDB is not available in this runtime");
  return factory;
}

function requestPromise<Result>(request: RequestLike<Result>): Promise<Result> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}
