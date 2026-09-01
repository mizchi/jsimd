/** Host operations required by structural regions. DOM adapters can implement these with insertBefore. */
export interface RegionHost<Node> {
  /** Insert or move an ordered node range immediately before `before`. */
  placeBefore(nodes: readonly Node[], before: Node): void;
  /** Remove an ordered node range from the host. Missing nodes may be ignored. */
  remove(nodes: readonly Node[]): void;
}

/**
 * One independently disposable subtree.
 *
 * `dispose` is the integration boundary for owner cleanup and packed-scheduler unregistration.
 * Empty output must be represented by a placeholder node so every segment has a stable range.
 */
export interface RegionSegment<Node, Item = never> {
  readonly nodes: readonly Node[];
  readonly dispose: () => void;
  readonly update?: (item: Item, index: number) => void;
}

/** Structural primitive for Show: at most one mounted segment before a stable end marker. */
export class ShowRegion<Node> {
  readonly #host: RegionHost<Node>;
  readonly #end: Node;
  #current: RegionSegment<Node> | null = null;
  #destroyed = false;

  constructor(host: RegionHost<Node>, end: Node) {
    this.#host = host;
    this.#end = end;
  }

  update(visible: boolean, mount: () => RegionSegment<Node>): void {
    this.#assertLive();
    if (visible) {
      if (this.#current !== null) return;
      const segment = mountValidSegment(mount);
      this.#host.placeBefore(segment.nodes, this.#end);
      this.#current = segment;
      return;
    }
    if (this.#current === null) return;
    const segment = this.#current;
    this.#current = null;
    disposeAndRemove(this.#host, segment);
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    if (this.#current === null) return;
    const segment = this.#current;
    this.#current = null;
    disposeAndRemove(this.#host, segment);
  }

  #assertLive(): void {
    if (this.#destroyed) throw new Error("region is destroyed");
  }
}

interface KeyedEntry<Key, Item, Node> {
  readonly key: Key;
  item: Item;
  readonly segment: RegionSegment<Node, Item>;
}

/** Structural primitive for For: keyed segments are reused and only their node ranges move. */
export class KeyedRegion<Key, Item, Node> {
  readonly #host: RegionHost<Node>;
  readonly #end: Node;
  #entries: KeyedEntry<Key, Item, Node>[] = [];
  #destroyed = false;

  constructor(host: RegionHost<Node>, end: Node) {
    this.#host = host;
    this.#end = end;
  }

  reconcile(
    items: readonly Item[],
    keyOf: (item: Item, index: number) => Key,
    mount: (item: Item, index: number) => RegionSegment<Node, Item>,
  ): void {
    this.#assertLive();
    const keys = new Array<Key>(items.length);
    const nextKeySet = new Set<Key>();
    for (let index = 0; index < items.length; index++) {
      const key = keyOf(items[index]!, index);
      if (nextKeySet.has(key)) throw new TypeError("duplicate region key");
      nextKeySet.add(key);
      keys[index] = key;
    }

    const previousByKey = new Map<Key, KeyedEntry<Key, Item, Node>>();
    for (const entry of this.#entries) previousByKey.set(entry.key, entry);
    const next = new Array<KeyedEntry<Key, Item, Node>>(items.length);
    const created: RegionSegment<Node, Item>[] = [];
    try {
      for (let index = 0; index < items.length; index++) {
        const item = items[index]!;
        const key = keys[index]!;
        const previous = previousByKey.get(key);
        if (previous !== undefined) {
          next[index] = previous;
          continue;
        }
        const segment = mountValidSegment(() => mount(item, index));
        created.push(segment);
        next[index] = { key, item, segment };
      }
    } catch (error) {
      for (let index = created.length - 1; index >= 0; index--) created[index]!.dispose();
      throw error;
    }

    let cursor = this.#end;
    for (let index = next.length - 1; index >= 0; index--) {
      const entry = next[index]!;
      const item = items[index]!;
      this.#host.placeBefore(entry.segment.nodes, cursor);
      if (previousByKey.has(entry.key)) entry.segment.update?.(item, index);
      entry.item = item;
      cursor = entry.segment.nodes[0]!;
    }

    for (const entry of this.#entries) {
      if (!nextKeySet.has(entry.key)) disposeAndRemove(this.#host, entry.segment);
    }
    this.#entries = next;
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    const entries = this.#entries;
    this.#entries = [];
    for (const entry of entries) disposeAndRemove(this.#host, entry.segment);
  }

  #assertLive(): void {
    if (this.#destroyed) throw new Error("region is destroyed");
  }
}

function validateSegment<Node, Item>(segment: RegionSegment<Node, Item>): void {
  if (typeof segment !== "object" || segment === null) {
    throw new TypeError("mount must return a region segment");
  }
  if (!Array.isArray(segment.nodes) || segment.nodes.length === 0) {
    throw new TypeError("region segment must contain at least one node");
  }
  if (typeof segment.dispose !== "function") {
    throw new TypeError("region segment dispose must be a function");
  }
}

function mountValidSegment<Node, Item>(
  mount: () => RegionSegment<Node, Item>,
): RegionSegment<Node, Item> {
  const segment = mount();
  try {
    validateSegment(segment);
    return segment;
  } catch (error) {
    if (
      typeof segment === "object" && segment !== null &&
      typeof segment.dispose === "function"
    ) segment.dispose();
    throw error;
  }
}

function disposeAndRemove<Node, Item>(
  host: RegionHost<Node>,
  segment: RegionSegment<Node, Item>,
): void {
  try {
    segment.dispose();
  } finally {
    host.remove(segment.nodes);
  }
}
