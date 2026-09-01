import { type DispatchStrategy, PackedSignalGraph } from "./signal_graph.ts";

export type { DispatchStrategy, PackedSignalGraphOptions } from "./signal_graph.ts";
export { PackedSignalGraph } from "./signal_graph.ts";

export interface UiNode {
  textContent: string | null;
}

export interface UiText extends UiNode {
  data: string;
}

export interface UiContainer extends UiNode {
  readonly childNodes: ArrayLike<UiNode>;
  appendChild<T extends UiNode>(child: T): T;
  removeChild<T extends UiNode>(child: T): T;
  replaceChild<T extends UiNode>(next: T, previous: UiNode): UiNode;
}

export interface UiElement extends UiContainer {
  setAttribute(name: string, value: string): void;
  addEventListener?(type: string, listener: (...args: unknown[]) => void): void;
}

export interface UiDocument {
  createElement(tagName: string): UiElement;
  createTextNode(data: string): UiText;
}

export interface SimdUiOptions {
  readonly document?: UiDocument;
  readonly dispatchStrategy?: DispatchStrategy;
}

export interface SimdUiStats {
  lastChangedSignalCount: number;
  lastEffectCount: number;
  lastDispatchStrategy: Exclude<DispatchStrategy, "auto"> | null;
}

export type UiChild = UiNode | string | number | null | undefined;

/** A signal belonging to one immutable SimdUi dependency graph. */
export class UiSignal<T> {
  readonly id: number;
  readonly #owner: SimdUi;
  #value: T;

  constructor(owner: SimdUi, id: number, initialValue: T) {
    this.#owner = owner;
    this.id = id;
    this.#value = initialValue;
  }

  get value(): T {
    return this.#value;
  }

  set value(next: T) {
    if (Object.is(this.#value, next)) return;
    this.#value = next;
    this.#owner.notify(this.id);
  }

  belongsTo(owner: SimdUi): boolean {
    return this.#owner === owner;
  }
}

/** Signal-driven DOM runtime with a fixed dependency graph. */
export class SimdUi {
  readonly stats: SimdUiStats = {
    lastChangedSignalCount: 0,
    lastEffectCount: 0,
    lastDispatchStrategy: null,
  };

  readonly #document: UiDocument;
  readonly #dispatchStrategy: DispatchStrategy;
  readonly #subscribersBySignal: number[][] = [];
  readonly #effects: Array<() => void> = [];
  #changedSignalFlags = new Uint8Array(0);
  #changedSignalIds = new Uint32Array(0);
  #changedSignalCount = 0;
  #graph: PackedSignalGraph | null = null;
  #batchDepth = 0;
  #flushing = false;
  #mounted = false;
  #host: UiContainer | null = null;
  #root: UiNode | null = null;

  constructor(options: SimdUiOptions = {}) {
    const browserDocument = (globalThis as { document?: UiDocument }).document;
    const document = options.document ?? browserDocument;
    if (document === undefined) throw new Error("document required");
    this.#document = document;
    this.#dispatchStrategy = options.dispatchStrategy ?? "auto";
  }

  signal<T>(initialValue: T): UiSignal<T> {
    this.#assertBuilding("signals");
    const signal = new UiSignal(this, this.#subscribersBySignal.length, initialValue);
    this.#subscribersBySignal.push([]);
    return signal;
  }

  effect(dependencies: readonly UiSignal<unknown>[], run: () => void): void {
    this.#assertBuilding("effects");
    if (!Array.isArray(dependencies)) throw new TypeError("dependencies must be an array");
    if (typeof run !== "function") throw new TypeError("run must be a function");
    const effectId = this.#effects.length;
    const signalIds = new Set<number>();
    for (const dependency of dependencies) {
      if (!(dependency instanceof UiSignal) || !dependency.belongsTo(this)) {
        throw new TypeError("every dependency must be a signal from this SimdUi instance");
      }
      signalIds.add(dependency.id);
    }
    for (const signalId of signalIds) this.#subscribersBySignal[signalId]!.push(effectId);
    this.#effects.push(run);
  }

  text(dependencies: readonly UiSignal<unknown>[], render: () => string): UiNode {
    if (typeof render !== "function") throw new TypeError("render must be a function");
    const node = this.#document.createTextNode("");
    this.effect(dependencies, () => node.data = render());
    return node;
  }

  element(
    tagName: string,
    properties: Readonly<Record<string, unknown>> = {},
    children: readonly UiChild[] = [],
  ): UiElement {
    this.#assertBuilding("elements");
    if (typeof tagName !== "string" || tagName.length === 0) {
      throw new TypeError("tagName required");
    }
    const element = this.#document.createElement(tagName);
    for (const [name, value] of Object.entries(properties)) this.#setProperty(element, name, value);
    for (const child of children) {
      if (child === null || child === undefined) continue;
      element.appendChild(
        typeof child === "string" || typeof child === "number"
          ? this.#document.createTextNode(String(child))
          : child,
      );
    }
    return element;
  }

  async mount(host: UiContainer, root: UiNode): Promise<this> {
    if (this.#mounted) throw new Error("already mounted");
    if (host === null || typeof host.appendChild !== "function") {
      throw new TypeError("host must be a DOM container");
    }
    this.#changedSignalFlags = new Uint8Array(this.#subscribersBySignal.length);
    this.#changedSignalIds = new Uint32Array(this.#subscribersBySignal.length);
    this.#mounted = true;
    this.#graph = await PackedSignalGraph.create({
      effectCount: this.#effects.length,
      subscribersBySignal: this.#subscribersBySignal,
    });
    this.#host = host;
    this.#root = root;
    host.appendChild(root);
    for (const effect of this.#effects) effect();
    this.flush();
    return this;
  }

  batch<T>(operation: () => T): T {
    if (typeof operation !== "function") throw new TypeError("operation must be a function");
    this.#batchDepth++;
    try {
      return operation();
    } finally {
      this.#batchDepth--;
      if (this.#batchDepth === 0) this.flush();
    }
  }

  flush(): void {
    if (
      !this.#mounted || this.#graph === null || this.#flushing || this.#changedSignalCount === 0
    ) {
      return;
    }
    this.#flushing = true;
    this.stats.lastChangedSignalCount = 0;
    this.stats.lastEffectCount = 0;
    let failed = false;
    let failure: unknown;
    try {
      while (this.#changedSignalCount > 0) {
        const changedCount = this.#changedSignalCount;
        const changed = this.#changedSignalIds.subarray(0, changedCount);
        this.#changedSignalCount = 0;
        for (const signalId of changed) this.#changedSignalFlags[signalId] = 0;
        this.stats.lastChangedSignalCount += changed.length;
        const effects = this.#graph.collectPacked(changed, this.#dispatchStrategy);
        this.stats.lastDispatchStrategy = this.#graph.lastStrategy;
        this.stats.lastEffectCount += effects.length;
        for (const effectId of effects) {
          try {
            this.#effects[effectId]!();
          } catch (error) {
            if (!failed) failure = error;
            failed = true;
          }
        }
      }
    } finally {
      this.#flushing = false;
    }
    if (failed) throw failure;
  }

  notify(signalId: number): void {
    if (!this.#mounted || this.#graph === null) return;
    if (this.#changedSignalFlags[signalId] !== 0) return;
    this.#changedSignalFlags[signalId] = 1;
    this.#changedSignalIds[this.#changedSignalCount++] = signalId;
    if (this.#batchDepth === 0) this.flush();
  }

  destroy(): void {
    if (this.#host !== null && this.#root !== null) this.#host.removeChild(this.#root);
    this.#host = null;
    this.#root = null;
    this.#graph = null;
    this.#effects.length = 0;
    this.#subscribersBySignal.length = 0;
    this.#changedSignalFlags.fill(0);
    this.#changedSignalCount = 0;
  }

  #setProperty(element: UiElement, name: string, value: unknown): void {
    if (name === "className") {
      element.setAttribute("class", String(value));
      return;
    }
    if (name.startsWith("on") && typeof value === "function" && element.addEventListener) {
      element.addEventListener(name.slice(2).toLowerCase(), value as (...args: unknown[]) => void);
      return;
    }
    if (Reflect.has(element, name)) Reflect.set(element, name, value);
    else if (value !== false && value !== null && value !== undefined) {
      element.setAttribute(name, value === true ? "" : String(value));
    }
  }

  #assertBuilding(subject: string): void {
    if (this.#mounted) throw new Error(`cannot add ${subject} after mount`);
  }
}
