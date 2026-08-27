import { summarizeBenchmarkSamples } from "./measure.ts";
import {
  type BenchmarkEnvironment,
  type BenchmarkResultV1,
  createBenchmarkResult,
} from "./result.ts";

export interface VitestBenchmarkCase {
  readonly name: string;
  readonly samplesMs: readonly number[];
  readonly fullSampleCount?: number;
}

export interface VitestBenchmarkResultInput {
  readonly name: string;
  readonly recordedAt: string;
  readonly environment: BenchmarkEnvironment;
  readonly cases: readonly VitestBenchmarkCase[];
  readonly sampleLimit?: number;
}

export function createVitestBenchmarkResult(
  input: VitestBenchmarkResultInput,
): BenchmarkResultV1 {
  if (input.cases.length === 0) throw new RangeError("benchmark cases must not be empty");
  for (const benchmarkCase of input.cases) {
    if (benchmarkCase.samplesMs.length === 0) {
      throw new RangeError(`${benchmarkCase.name}: raw samples must not be empty`);
    }
  }
  const requestedLimit = input.sampleLimit ?? 20;
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
    throw new RangeError("sampleLimit must be a positive integer");
  }
  const sampleCount = Math.min(
    requestedLimit,
    ...input.cases.map((benchmarkCase) => benchmarkCase.samplesMs.length),
  );
  const measurements = input.cases.map((benchmarkCase) =>
    summarizeBenchmarkSamples(
      benchmarkCase.name,
      "resident",
      retainUniformSamples(benchmarkCase.samplesMs, sampleCount),
    )
  );
  return createBenchmarkResult({
    name: input.name,
    recordedAt: input.recordedAt,
    environment: input.environment,
    timing: { warmups: 0, samples: sampleCount, operationsPerSample: 1 },
    input: { shape: { benchmarkCount: input.cases.length, runner: "vitest" } },
    correctness: {
      passed: true,
      checks: input.cases.length,
      summary: "Every Vitest benchmark case completed without an uncaught error.",
    },
    measurements,
    metrics: {
      retainedSamplesPerMeasurement: sampleCount,
      fullSampleCountMin: Math.min(
        ...input.cases.map((item) => item.fullSampleCount ?? item.samplesMs.length),
      ),
      fullSampleCountMax: Math.max(
        ...input.cases.map((item) => item.fullSampleCount ?? item.samplesMs.length),
      ),
    },
    notes: [
      "Measurements contain actual Tinybench samples selected uniformly from the exposed distribution to keep the committed result bounded.",
      "Vitest performs time-based warmup; timing.warmups is zero because the runner does not expose a warmup iteration count.",
      "The resident boundary covers only each benchmark callback; suite setup and module initialization are excluded.",
    ],
  });
}

export function retainUniformSamples(
  samples: readonly number[],
  count: number,
): number[] {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new RangeError("retained sample count must be a positive integer");
  }
  if (samples.length <= count) return [...samples];
  if (count === 1) return [samples[Math.floor((samples.length - 1) / 2)]!];
  return Array.from(
    { length: count },
    (_, index) => samples[Math.round(index * (samples.length - 1) / (count - 1))]!,
  );
}
