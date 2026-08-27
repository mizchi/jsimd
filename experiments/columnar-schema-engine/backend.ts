/** Atomic key/value byte storage used for manifests and immutable column pages. */
export interface PageBackend {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<readonly string[]>;
  [Symbol.dispose]?(): void;
}

export class MemoryPageBackend implements PageBackend {
  readonly #values = new Map<string, Uint8Array>();

  get(key: string): Promise<Uint8Array | undefined> {
    validateKey(key);
    const value = this.#values.get(key);
    return Promise.resolve(value?.slice());
  }

  put(key: string, value: Uint8Array): Promise<void> {
    validateKey(key);
    if (!(value instanceof Uint8Array)) throw new TypeError("page value must be a Uint8Array");
    this.#values.set(key, value.slice());
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    validateKey(key);
    this.#values.delete(key);
    return Promise.resolve();
  }

  list(prefix: string): Promise<readonly string[]> {
    validatePrefix(prefix);
    return Promise.resolve(
      Array.from(this.#values.keys()).filter((key) => key.startsWith(prefix)).sort(),
    );
  }
}

export function validateKey(key: string): void {
  if (
    key.length === 0 || key.startsWith("/") || key.endsWith("/") || key.includes("\\") ||
    key.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new RangeError(`invalid page key ${JSON.stringify(key)}`);
  }
}

export function validatePrefix(prefix: string): void {
  if (prefix === "") return;
  const key = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  validateKey(key);
}
