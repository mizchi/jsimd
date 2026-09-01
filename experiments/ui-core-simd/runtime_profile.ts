import { type BenchmarkSummary, summarizeSamples } from "./benchmark_stats.ts";

const ATOMIC_HEADER_BYTES = 64;
const PROFILE_SIGNAL_COUNT = 64;

export interface InteractionSample {
  readonly inputDelayMs: number;
  readonly eventLoopDelayMs: number;
  readonly mainThreadMs: number;
  readonly workerMs: number;
  readonly commitMs: number;
  readonly eventToDomMs: number;
}

export interface InteractionSummary {
  readonly inputDelay: BenchmarkSummary;
  readonly eventLoopDelay: BenchmarkSummary;
  readonly mainThread: BenchmarkSummary;
  readonly worker: BenchmarkSummary;
  readonly commit: BenchmarkSummary;
  readonly eventToDom: BenchmarkSummary;
}

export interface AtomicBridgeMemoryEstimate {
  readonly valueBytes: number;
  readonly dirtyBytes: number;
  readonly totalBytes: number;
}

export function summarizeInteractionSamples(
  samples: readonly InteractionSample[],
): InteractionSummary {
  if (samples.length === 0) throw new RangeError("interaction samples required");
  return {
    inputDelay: summarizeSamples(samples.map((sample) => sample.inputDelayMs)),
    eventLoopDelay: summarizeSamples(samples.map((sample) => sample.eventLoopDelayMs)),
    mainThread: summarizeSamples(samples.map((sample) => sample.mainThreadMs)),
    worker: summarizeSamples(samples.map((sample) => sample.workerMs)),
    commit: summarizeSamples(samples.map((sample) => sample.commitMs)),
    eventToDom: summarizeSamples(samples.map((sample) => sample.eventToDomMs)),
  };
}

export function estimateAtomicBridgeBytes(bindingCount: number): AtomicBridgeMemoryEstimate {
  validateProfileBindingCount(bindingCount);
  const valueBytes = bindingCount * Int32Array.BYTES_PER_ELEMENT;
  const dirtyBytes = ATOMIC_HEADER_BYTES + Math.ceil(bindingCount / 32) * 4;
  return { valueBytes, dirtyBytes, totalBytes: valueBytes + dirtyBytes };
}

export function validateProfileBindingCount(bindingCount: number): number {
  if (
    !Number.isSafeInteger(bindingCount) || bindingCount <= 0 ||
    bindingCount % PROFILE_SIGNAL_COUNT !== 0
  ) {
    throw new RangeError(
      `profile binding count must be a positive multiple of ${PROFILE_SIGNAL_COUNT}`,
    );
  }
  return bindingCount;
}
