import { summarizeSamples } from "./benchmark_stats.ts";
import { stepLife } from "./life_game.ts";
import { WasmSimdLife } from "./life_kernel.ts";

interface LifeKernelBenchmark {
  readonly size: string;
  readonly cells: number;
  readonly scalarMedianMicros: number;
  readonly scalarP95Micros: number;
  readonly simdMedianMicros: number;
  readonly simdP95Micros: number;
  readonly speedup: number;
}

const results: LifeKernelBenchmark[] = [];
for (const [width, height] of [[256, 160], [512, 320], [1_024, 640]] as const) {
  results.push(await compare(width, height));
}
console.table(results.map((result) => ({
  grid: result.size,
  cells: result.cells.toLocaleString(),
  "scalar median": `${result.scalarMedianMicros.toFixed(1)} µs`,
  "scalar p95": `${result.scalarP95Micros.toFixed(1)} µs`,
  "SIMD median": `${result.simdMedianMicros.toFixed(1)} µs`,
  "SIMD p95": `${result.simdP95Micros.toFixed(1)} µs`,
  speedup: `${result.speedup.toFixed(2)}×`,
})));

async function compare(width: number, height: number): Promise<LifeKernelBenchmark> {
  const cellCount = width * height;
  const initial = randomBoard(cellCount, cellCount ^ 0x6d2b_79f5);
  let scalarCurrent: Uint8Array = initial.slice();
  let scalarNext: Uint8Array = new Uint8Array(cellCount);
  const simd = await WasmSimdLife.create(width, height);
  simd.set(initial);
  const stepsPerSample = Math.max(2, Math.floor(2_000_000 / cellCount));

  for (let index = 0; index < 8; index++) {
    stepLife(scalarCurrent, scalarNext, width, height);
    [scalarCurrent, scalarNext] = [scalarNext, scalarCurrent];
    simd.step();
  }

  const scalarSamples = sample(15, stepsPerSample, () => {
    stepLife(scalarCurrent, scalarNext, width, height);
    [scalarCurrent, scalarNext] = [scalarNext, scalarCurrent];
  });
  const simdSamples = sample(15, stepsPerSample, () => {
    simd.step();
  });
  const scalar = summarizeSamples(scalarSamples);
  const simdSummary = summarizeSamples(simdSamples);
  return {
    size: `${width} × ${height}`,
    cells: cellCount,
    scalarMedianMicros: scalar.median * 1_000,
    scalarP95Micros: scalar.p95 * 1_000,
    simdMedianMicros: simdSummary.median * 1_000,
    simdP95Micros: simdSummary.p95 * 1_000,
    speedup: scalar.median / simdSummary.median,
  };
}

function sample(count: number, steps: number, operation: () => void): number[] {
  const samples = new Array<number>(count);
  for (let sample = 0; sample < count; sample++) {
    const started = performance.now();
    for (let step = 0; step < steps; step++) operation();
    samples[sample] = (performance.now() - started) / steps;
  }
  return samples;
}

function randomBoard(length: number, initialSeed: number): Uint8Array {
  const cells = new Uint8Array(length);
  let seed = initialSeed;
  for (let index = 0; index < length; index++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    cells[index] = (seed >>> 0) % 100 < 28 ? 1 : 0;
  }
  return cells;
}
