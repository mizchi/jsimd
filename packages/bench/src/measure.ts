export type BenchmarkBoundary =
  | "resident"
  | "construction-inclusive"
  | "materialization-inclusive"
  | "end-to-end";

export interface BenchmarkTiming {
  readonly warmups: number;
  readonly samples: number;
  readonly operationsPerSample?: number;
  readonly now?: () => number;
}

export interface BenchmarkMeasurement {
  readonly name: string;
  readonly boundary: BenchmarkBoundary;
  readonly unit: "ms";
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly samplesMs: readonly number[];
}

export function summarizeBenchmarkSamples(
  name: string,
  boundary: BenchmarkBoundary,
  samplesMs: readonly number[],
): BenchmarkMeasurement {
  if (name.length === 0) throw new RangeError("measurement name must not be empty");
  if (samplesMs.length === 0) throw new RangeError("measurement samples must not be empty");
  for (const sample of samplesMs) {
    if (!Number.isFinite(sample) || sample < 0) {
      throw new RangeError("measurement samples must be finite and non-negative");
    }
  }
  const sorted = [...samplesMs].sort((left, right) => left - right);
  return Object.freeze({
    name,
    boundary,
    unit: "ms" as const,
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    minMs: sorted[0]!,
    maxMs: sorted.at(-1)!,
    samplesMs: Object.freeze([...samplesMs]),
  });
}

type MaybePromise<T> = T | Promise<T>;

export function measureResident(
  name: string,
  timing: BenchmarkTiming,
  operation: () => MaybePromise<unknown>,
): Promise<BenchmarkMeasurement> {
  return measure(name, "resident", timing, operation);
}

export function measureEndToEnd(
  name: string,
  timing: BenchmarkTiming,
  operation: () => MaybePromise<unknown>,
): Promise<BenchmarkMeasurement> {
  return measure(name, "end-to-end", timing, operation);
}

export function measureMaterializationInclusive<T, U>(
  name: string,
  timing: BenchmarkTiming,
  operation: () => MaybePromise<T>,
  materialize: (value: T) => MaybePromise<U>,
): Promise<BenchmarkMeasurement> {
  return measure(name, "materialization-inclusive", timing, async () => {
    await materialize(await operation());
  });
}

export function measureConstructionInclusive<T>(
  name: string,
  timing: BenchmarkTiming,
  construct: () => MaybePromise<T>,
  operation: (value: T) => MaybePromise<unknown>,
): Promise<BenchmarkMeasurement> {
  return measure(name, "construction-inclusive", timing, async () => {
    const value = await construct();
    try {
      await operation(value);
    } finally {
      await dispose(value);
    }
  });
}

async function measure(
  name: string,
  boundary: BenchmarkBoundary,
  timing: BenchmarkTiming,
  operation: () => MaybePromise<unknown>,
): Promise<BenchmarkMeasurement> {
  if (name.length === 0) throw new RangeError("measurement name must not be empty");
  const warmups = nonNegativeInteger(timing.warmups, "warmups");
  const samples = positiveInteger(timing.samples, "samples");
  const operationsPerSample = positiveInteger(
    timing.operationsPerSample ?? 1,
    "operationsPerSample",
  );
  const now = timing.now ?? (() => performance.now());
  for (let index = 0; index < warmups; index++) await operation();
  const values: number[] = [];
  for (let index = 0; index < samples; index++) {
    const started = now();
    for (let operationIndex = 0; operationIndex < operationsPerSample; operationIndex++) {
      await operation();
    }
    const elapsed = (now() - started) / operationsPerSample;
    if (!Number.isFinite(elapsed) || elapsed < 0) {
      throw new RangeError("benchmark clock must produce finite monotonic durations");
    }
    values.push(elapsed);
  }
  return summarizeBenchmarkSamples(name, boundary, values);
}

async function dispose(value: unknown): Promise<void> {
  if (typeof value !== "object" || value === null) return;
  const asyncDisposable = value as { [Symbol.asyncDispose]?: () => PromiseLike<void> };
  const disposeAsync = asyncDisposable[Symbol.asyncDispose];
  if (typeof disposeAsync === "function") {
    await disposeAsync.call(value);
    return;
  }
  const disposable = value as { [Symbol.dispose]?: () => void };
  disposable[Symbol.dispose]?.();
}

function percentile(sorted: readonly number[], quantile: number): number {
  const rank = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[Math.min(sorted.length - 1, rank)]!;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return value;
}
