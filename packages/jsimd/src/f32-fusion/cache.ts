export class LruPromiseCache<Value> {
  readonly #entries = new Map<string, Promise<Value>>();
  readonly maximum: number;

  constructor(maximum: number) {
    this.maximum = maximum;
  }

  get size(): number {
    return this.#entries.size;
  }

  getOrCreate(key: string, create: () => Promise<Value>): Promise<Value> {
    const cached = this.#entries.get(key);
    if (cached !== undefined) {
      this.#entries.delete(key);
      this.#entries.set(key, cached);
      return cached;
    }
    const value = create();
    this.#entries.set(key, value);
    while (this.#entries.size > this.maximum) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    value.catch(() => {
      if (this.#entries.get(key) === value) this.#entries.delete(key);
    });
    return value;
  }

  clear(): void {
    this.#entries.clear();
  }
}
