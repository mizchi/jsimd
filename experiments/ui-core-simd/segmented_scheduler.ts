import { type DispatchStrategy, PackedSignalGraph } from "./signal_graph.ts";

export interface SegmentedEffectBinding {
  readonly signalIds: readonly number[];
  readonly run: () => void;
}

export interface SegmentedEffectSchedulerOptions {
  readonly signalCount: number;
  readonly rebuildChunkSize?: number;
  readonly tombstoneRatio?: number;
  readonly dispatchStrategy?: DispatchStrategy;
  readonly wasm?: boolean;
}

export interface EffectSegmentHandle {
  dispose(): void;
}

export interface SegmentedEffectSchedulerStats {
  baseEffectCount: number;
  baseTombstoneCount: number;
  overlayEffectCount: number;
  rebuildCount: number;
  lastChangedSignalCount: number;
  lastEffectCount: number;
  lastDispatchStrategy: Exclude<DispatchStrategy, "auto"> | null;
}

interface EffectRecord {
  readonly sequence: number;
  readonly signalIds: Uint32Array;
  readonly run: () => void;
  active: boolean;
  baseIndex: number;
  overlayMark: number;
}

interface PackedBase {
  readonly graph: PackedSignalGraph;
  readonly records: readonly EffectRecord[];
  readonly active: Uint8Array;
}

/**
 * Mutable lifecycle shell around an immutable packed graph.
 *
 * Registrations enter a small scalar overlay synchronously. Disposals of packed effects only clear
 * an active slot. The base is rebuilt after one overlay chunk or enough tombstones accumulate.
 */
export class SegmentedEffectScheduler {
  readonly stats: SegmentedEffectSchedulerStats = {
    baseEffectCount: 0,
    baseTombstoneCount: 0,
    overlayEffectCount: 0,
    rebuildCount: 0,
    lastChangedSignalCount: 0,
    lastEffectCount: 0,
    lastDispatchStrategy: null,
  };

  readonly #signalCount: number;
  readonly #rebuildChunkSize: number;
  readonly #tombstoneRatio: number;
  readonly #dispatchStrategy: DispatchStrategy;
  readonly #wasm: boolean;
  readonly #overlayBySignal: Set<EffectRecord>[];
  readonly #changedFlags: Uint8Array;
  readonly #changedIds: Uint32Array;
  #changedCount = 0;
  #base: PackedBase | null = null;
  #overlay: EffectRecord[] = [];
  #overlayActiveCount = 0;
  #baseTombstones = 0;
  #nextSequence = 0;
  #version = 0;
  #overlayGeneration = 0;
  #rebuildPromise: Promise<void> | null = null;
  #batchDepth = 0;
  #flushing = false;
  #destroyed = false;

  constructor(options: SegmentedEffectSchedulerOptions) {
    if (typeof options !== "object" || options === null) throw new TypeError("options required");
    this.#signalCount = validateCount(options.signalCount, "signalCount");
    this.#rebuildChunkSize = validatePositiveCount(
      options.rebuildChunkSize ?? 64,
      "rebuildChunkSize",
    );
    const tombstoneRatio = options.tombstoneRatio ?? 0.5;
    if (!Number.isFinite(tombstoneRatio) || tombstoneRatio <= 0 || tombstoneRatio > 1) {
      throw new RangeError("tombstoneRatio must be greater than zero and at most one");
    }
    this.#tombstoneRatio = tombstoneRatio;
    this.#dispatchStrategy = options.dispatchStrategy ?? "auto";
    this.#wasm = options.wasm !== false;
    this.#overlayBySignal = Array.from({ length: this.#signalCount }, () => new Set());
    this.#changedFlags = new Uint8Array(this.#signalCount);
    this.#changedIds = new Uint32Array(this.#signalCount);
  }

  registerSegment(bindings: readonly SegmentedEffectBinding[]): EffectSegmentHandle {
    this.#assertLive();
    if (!Array.isArray(bindings)) throw new TypeError("bindings must be an array");
    const prepared = bindings.map((binding) => {
      if (typeof binding !== "object" || binding === null || typeof binding.run !== "function") {
        throw new TypeError("every binding must have a run function");
      }
      if (!Array.isArray(binding.signalIds)) throw new TypeError("signalIds must be an array");
      const unique = new Set<number>();
      for (const signalId of binding.signalIds) {
        validateIndex(signalId, this.#signalCount, "signal ID");
        unique.add(signalId);
      }
      return { signalIds: Uint32Array.from(unique), run: binding.run };
    });

    const records = prepared.map((binding): EffectRecord => ({
      sequence: this.#nextSequence++,
      signalIds: binding.signalIds,
      run: binding.run,
      active: true,
      baseIndex: -1,
      overlayMark: 0,
    }));
    for (const record of records) {
      this.#overlay.push(record);
      this.#overlayActiveCount++;
      for (const signalId of record.signalIds) this.#overlayBySignal[signalId]!.add(record);
    }
    if (records.length > 0) this.#version++;
    this.#syncStats();
    this.#scheduleIfNeeded();

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        let changed = false;
        for (const record of records) changed = this.#deactivate(record) || changed;
        if (changed) {
          this.#version++;
          this.#syncStats();
          this.#scheduleIfNeeded();
        }
      },
    };
  }

  notify(signalId: number): void {
    this.#assertLive();
    validateIndex(signalId, this.#signalCount, "signal ID");
    if (this.#changedFlags[signalId] !== 0) return;
    this.#changedFlags[signalId] = 1;
    this.#changedIds[this.#changedCount++] = signalId;
    if (this.#batchDepth === 0 && !this.#flushing) this.flush();
  }

  batch<T>(operation: () => T): T {
    this.#assertLive();
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
    if (this.#flushing || this.#changedCount === 0) return;
    this.#flushing = true;
    this.stats.lastChangedSignalCount = 0;
    this.stats.lastEffectCount = 0;
    this.stats.lastDispatchStrategy = null;
    let failed = false;
    let failure: unknown;
    try {
      while (this.#changedCount > 0) {
        const changedCount = this.#changedCount;
        const changed = this.#changedIds.subarray(0, changedCount);
        this.#changedCount = 0;
        for (const signalId of changed) this.#changedFlags[signalId] = 0;
        this.stats.lastChangedSignalCount += changedCount;

        const base = this.#base;
        const baseEffectIds = base?.graph.collectPacked(changed, this.#dispatchStrategy) ??
          new Uint32Array(0);
        if (base !== null) this.stats.lastDispatchStrategy = base.graph.lastStrategy;
        const overlay = this.#collectOverlay(changed);

        for (const effectId of baseEffectIds) {
          if (base === null || base.active[effectId] === 0) continue;
          this.stats.lastEffectCount++;
          try {
            base.records[effectId]!.run();
          } catch (error) {
            if (!failed) failure = error;
            failed = true;
          }
        }
        for (const record of overlay) {
          if (!record.active || record.baseIndex >= 0) continue;
          this.stats.lastEffectCount++;
          try {
            record.run();
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

  /** Force the active base and scalar overlay into one fresh immutable graph. */
  compact(): Promise<void> {
    this.#assertLive();
    return this.#ensureRebuild();
  }

  /** Wait for an automatically scheduled rebuild, if any. */
  async settle(): Promise<void> {
    while (this.#rebuildPromise !== null) await this.#rebuildPromise;
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    if (this.#base !== null) {
      for (const record of this.#base.records) record.active = false;
    }
    for (const record of this.#overlay) record.active = false;
    this.#base = null;
    this.#overlay = [];
    this.#overlayActiveCount = 0;
    this.#baseTombstones = 0;
    this.#changedFlags.fill(0);
    this.#changedCount = 0;
    for (const subscribers of this.#overlayBySignal) subscribers.clear();
    this.#version++;
    this.#syncStats();
  }

  #deactivate(record: EffectRecord): boolean {
    if (!record.active) return false;
    record.active = false;
    if (record.baseIndex >= 0 && this.#base !== null) {
      this.#base.active[record.baseIndex] = 0;
      this.#baseTombstones++;
    } else {
      this.#overlayActiveCount--;
      for (const signalId of record.signalIds) this.#overlayBySignal[signalId]!.delete(record);
    }
    return true;
  }

  #collectOverlay(changed: Uint32Array): EffectRecord[] {
    this.#overlayGeneration = (this.#overlayGeneration + 1) >>> 0;
    if (this.#overlayGeneration === 0) {
      for (const record of this.#overlay) record.overlayMark = 0;
      this.#overlayGeneration = 1;
    }
    const generation = this.#overlayGeneration;
    const selected: EffectRecord[] = [];
    for (const signalId of changed) {
      for (const record of this.#overlayBySignal[signalId]!) {
        if (!record.active || record.overlayMark === generation) continue;
        record.overlayMark = generation;
        selected.push(record);
      }
    }
    selected.sort((left, right) => left.sequence - right.sequence);
    return selected;
  }

  #scheduleIfNeeded(): void {
    const baseCount = this.#base?.records.length ?? 0;
    const tombstoneThresholdReached = baseCount > 0 &&
      this.#baseTombstones / baseCount >= this.#tombstoneRatio;
    if (this.#overlayActiveCount >= this.#rebuildChunkSize || tombstoneThresholdReached) {
      void this.#ensureRebuild().catch(() => {});
    }
  }

  #ensureRebuild(): Promise<void> {
    if (this.#rebuildPromise !== null) return this.#rebuildPromise;
    const rebuild = this.#rebuildUntilStable();
    this.#rebuildPromise = rebuild;
    void rebuild.finally(() => {
      if (this.#rebuildPromise === rebuild) this.#rebuildPromise = null;
    }).catch(() => {});
    return rebuild;
  }

  async #rebuildUntilStable(): Promise<void> {
    while (!this.#destroyed) {
      const version = this.#version;
      const records = this.#activeRecords();
      let graph: PackedSignalGraph | null = null;
      if (records.length > 0) {
        const subscribersBySignal: number[][] = Array.from(
          { length: this.#signalCount },
          () => [],
        );
        for (let effectId = 0; effectId < records.length; effectId++) {
          for (const signalId of records[effectId]!.signalIds) {
            subscribersBySignal[signalId]!.push(effectId);
          }
        }
        graph = await PackedSignalGraph.create({
          effectCount: records.length,
          subscribersBySignal,
          wasm: this.#wasm,
        });
      }
      if (version !== this.#version) continue;

      if (this.#base !== null) {
        for (const record of this.#base.records) record.baseIndex = -1;
      }
      for (const subscribers of this.#overlayBySignal) subscribers.clear();
      this.#overlay = [];
      this.#overlayActiveCount = 0;
      this.#baseTombstones = 0;
      if (graph === null) {
        this.#base = null;
      } else {
        for (let index = 0; index < records.length; index++) records[index]!.baseIndex = index;
        this.#base = { graph, records, active: new Uint8Array(records.length).fill(1) };
      }
      this.stats.rebuildCount++;
      this.#syncStats();
      return;
    }
  }

  #activeRecords(): EffectRecord[] {
    const records: EffectRecord[] = [];
    if (this.#base !== null) {
      for (const record of this.#base.records) if (record.active) records.push(record);
    }
    for (const record of this.#overlay) if (record.active) records.push(record);
    records.sort((left, right) => left.sequence - right.sequence);
    return records;
  }

  #syncStats(): void {
    this.stats.baseEffectCount = this.#base?.records.length ?? 0;
    this.stats.baseTombstoneCount = this.#baseTombstones;
    this.stats.overlayEffectCount = this.#overlayActiveCount;
  }

  #assertLive(): void {
    if (this.#destroyed) throw new Error("scheduler is destroyed");
  }
}

function validateCount(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${name} must be an unsigned 32-bit integer`);
  }
  return value;
}

function validatePositiveCount(value: number, name: string): number {
  const count = validateCount(value, name);
  if (count === 0) throw new RangeError(`${name} must be positive`);
  return count;
}

function validateIndex(value: number, length: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value >= length) {
    throw new RangeError(`${name} out of bounds`);
  }
}
