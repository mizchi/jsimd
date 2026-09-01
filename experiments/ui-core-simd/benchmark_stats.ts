export interface BenchmarkSummary {
  readonly median: number;
  readonly p95: number;
}

export function summarizeSamples(samples: readonly number[]): BenchmarkSummary {
  if (samples.length === 0) throw new RangeError("samples required");
  const sorted = samples.toSorted((left, right) => left - right);
  return {
    median: sorted[Math.floor(sorted.length / 2)]!,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
  };
}
