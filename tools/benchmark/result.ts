import type { BenchmarkMeasurement } from "./measure.ts";

export interface BenchmarkAdapter {
  readonly vendor?: string;
  readonly architecture?: string;
  readonly device?: string;
  readonly description?: string;
}

export interface BenchmarkEnvironment {
  readonly runtime: {
    readonly name: string;
    readonly version: string;
    readonly userAgent?: string;
  };
  readonly platform: string;
  readonly logicalCpus: number;
  readonly cpu: string;
  readonly adapter: BenchmarkAdapter | null;
  readonly crossOriginIsolated?: boolean;
}

export type BenchmarkShapeValue = number | string | boolean | readonly number[];

export interface BenchmarkResultV1 {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly recordedAt: string;
  readonly environment: BenchmarkEnvironment;
  readonly timing: {
    readonly warmups: number;
    readonly samples: number;
    readonly operationsPerSample: number;
  };
  readonly input: {
    readonly shape: Readonly<Record<string, BenchmarkShapeValue>>;
    readonly bytes?: number;
  };
  readonly correctness: {
    readonly passed: true;
    readonly checks: number;
    readonly summary: string;
  };
  readonly measurements: readonly BenchmarkMeasurement[];
  readonly metrics?: Readonly<Record<string, number | string | boolean>>;
  readonly notes?: readonly string[];
}

export interface BenchmarkEnvironmentOptions {
  readonly runtimeName?: string;
  readonly runtimeVersion?: string;
  readonly userAgent?: string;
  readonly platform?: string;
  readonly logicalCpus?: number;
  readonly cpu?: string;
  readonly adapter?: BenchmarkAdapter | null;
  readonly crossOriginIsolated?: boolean;
}

export function detectBenchmarkEnvironment(
  options: BenchmarkEnvironmentOptions = {},
): BenchmarkEnvironment {
  const deno = globalThis as typeof globalThis & {
    Deno?: { version?: { deno?: string }; build?: { os?: string; arch?: string } };
    process?: { version?: string; platform?: string; arch?: string };
  };
  const navigatorLike = globalThis.navigator as
    | (Navigator & { readonly platform?: string })
    | undefined;
  const userAgent = options.userAgent ?? navigatorLike?.userAgent;
  const runtimeName = options.runtimeName ??
    (deno.Deno !== undefined ? "deno" : deno.process !== undefined ? "node" : "browser");
  const runtimeVersion = options.runtimeVersion ?? deno.Deno?.version?.deno ??
    deno.process?.version ?? userAgent ?? "unknown";
  const detectedPlatform = [deno.Deno?.build?.os, deno.Deno?.build?.arch]
    .filter(Boolean).join("-") ||
    [deno.process?.platform, deno.process?.arch]
      .filter(Boolean).join("-") ||
    navigatorLike?.platform || "unknown";
  const platform = options.platform ?? detectedPlatform;
  const logicalCpus = options.logicalCpus ?? navigatorLike?.hardwareConcurrency ?? 1;
  if (!Number.isSafeInteger(logicalCpus) || logicalCpus < 1) {
    throw new RangeError("logicalCpus must be a positive integer");
  }
  return Object.freeze({
    runtime: Object.freeze({
      name: runtimeName,
      version: runtimeVersion,
      ...(userAgent === undefined ? {} : { userAgent }),
    }),
    platform,
    logicalCpus,
    cpu: options.cpu ?? "unavailable",
    adapter: options.adapter == null ? null : Object.freeze({ ...options.adapter }),
    ...(options.crossOriginIsolated === undefined
      ? {}
      : { crossOriginIsolated: options.crossOriginIsolated }),
  });
}

export function createBenchmarkResult(
  input: Omit<BenchmarkResultV1, "schemaVersion">,
): BenchmarkResultV1 {
  const result = {
    schemaVersion: 1 as const,
    ...input,
    measurements: Object.freeze([...input.measurements]),
  };
  validateBenchmarkResult(result);
  return Object.freeze(result);
}

export function validateBenchmarkResult(value: unknown): asserts value is BenchmarkResultV1 {
  const result = record(value, "benchmark result");
  equal(result.schemaVersion, 1, "schemaVersion");
  nonEmptyString(result.name, "name");
  const recordedAt = nonEmptyString(result.recordedAt, "recordedAt");
  if (Number.isNaN(Date.parse(recordedAt))) throw new RangeError("recordedAt must be an ISO date");
  validateEnvironment(result.environment);
  const timing = record(result.timing, "timing");
  nonNegativeInteger(timing.warmups, "timing.warmups");
  const sampleCount = positiveInteger(timing.samples, "timing.samples");
  positiveInteger(timing.operationsPerSample, "timing.operationsPerSample");
  const benchmarkInput = record(result.input, "input");
  const shape = record(benchmarkInput.shape, "input.shape");
  if (Object.keys(shape).length === 0) throw new RangeError("input.shape must not be empty");
  for (const [key, shapeValue] of Object.entries(shape)) validateShapeValue(shapeValue, key);
  if (benchmarkInput.bytes !== undefined) nonNegativeInteger(benchmarkInput.bytes, "input.bytes");
  const correctness = record(result.correctness, "correctness");
  equal(correctness.passed, true, "correctness.passed");
  positiveInteger(correctness.checks, "correctness.checks");
  nonEmptyString(correctness.summary, "correctness.summary");
  if (!Array.isArray(result.measurements) || result.measurements.length === 0) {
    throw new RangeError("measurements must not be empty");
  }
  let hasEndToEnd = false;
  for (const measurement of result.measurements) {
    const item = record(measurement, "measurement");
    nonEmptyString(item.name, "measurement.name");
    if (
      item.boundary !== "resident" && item.boundary !== "construction-inclusive" &&
      item.boundary !== "materialization-inclusive" && item.boundary !== "end-to-end"
    ) throw new RangeError("measurement.boundary is invalid");
    hasEndToEnd ||= item.boundary === "end-to-end";
    equal(item.unit, "ms", "measurement.unit");
    for (const key of ["medianMs", "p95Ms", "minMs", "maxMs"] as const) {
      finiteNonNegative(item[key], `measurement.${key}`);
    }
    if (!Array.isArray(item.samplesMs) || item.samplesMs.length !== sampleCount) {
      throw new RangeError("measurement.samplesMs must match timing.samples");
    }
    for (const sample of item.samplesMs) finiteNonNegative(sample, "measurement sample");
  }
  if (!hasEndToEnd) throw new RangeError("at least one end-to-end measurement is required");
  if (result.metrics !== undefined) {
    const metrics = record(result.metrics, "metrics");
    for (const [key, metric] of Object.entries(metrics)) {
      if (typeof metric === "number") finiteNonNegative(metric, `metrics.${key}`);
      else if (typeof metric !== "string" && typeof metric !== "boolean") {
        throw new RangeError(`metrics.${key} is invalid`);
      }
    }
  }
  if (result.notes !== undefined) {
    if (!Array.isArray(result.notes)) throw new RangeError("notes must be an array");
    for (const note of result.notes) nonEmptyString(note, "note");
  }
}

function validateEnvironment(value: unknown): void {
  const environment = record(value, "environment");
  const runtime = record(environment.runtime, "environment.runtime");
  nonEmptyString(runtime.name, "environment.runtime.name");
  nonEmptyString(runtime.version, "environment.runtime.version");
  if (runtime.userAgent !== undefined) nonEmptyString(runtime.userAgent, "userAgent");
  nonEmptyString(environment.platform, "environment.platform");
  positiveInteger(environment.logicalCpus, "environment.logicalCpus");
  nonEmptyString(environment.cpu, "environment.cpu");
  if (environment.adapter !== null) {
    const adapter = record(environment.adapter, "environment.adapter");
    if (Object.keys(adapter).length === 0) throw new RangeError("adapter must describe the device");
    for (const value of Object.values(adapter)) nonEmptyString(value, "adapter field");
  }
}

function validateShapeValue(value: unknown, key: string): void {
  if (typeof value === "number") {
    finiteNonNegative(value, `input.shape.${key}`);
    return;
  }
  if (typeof value === "string" && value.length > 0 || typeof value === "boolean") return;
  if (Array.isArray(value) && value.length > 0) {
    for (const item of value) finiteNonNegative(item, `input.shape.${key}`);
    return;
  }
  throw new RangeError(`input.shape.${key} is invalid`);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RangeError(`${name} must be a non-empty string`);
  }
  return value;
}

function finiteNonNegative(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return value;
}

function equal(value: unknown, expected: unknown, name: string): void {
  if (value !== expected) throw new RangeError(`${name} must equal ${String(expected)}`);
}
