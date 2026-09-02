import { detectHostCpu, runBrowserBenchmark } from "../packages/bench/src/browser_runner.ts";
import { summarizeBenchmarkSamples } from "../packages/bench/src/measure.ts";
import { createBenchmarkResult } from "../packages/bench/src/result.ts";

interface GpuCase {
  readonly width: number;
  readonly height: number;
  readonly capacity: number;
  readonly ticks: number;
  readonly cadence: number;
  readonly totalEvents: number;
  readonly retainedEvents: number;
  readonly droppedEvents: number;
  readonly residentBytes: number;
  readonly readbackBytes: number;
  readonly stagingBytes: number;
  readonly elapsedPerTickMs: number;
  readonly readbackSamplesMs: readonly number[];
  readonly submitSamplesMs: readonly number[];
  readonly stateMismatches: number;
}

interface WasmCase {
  readonly width: number;
  readonly height: number;
  readonly totalEvents: number;
  readonly droppedEvents: number;
  readonly residentBytes: number;
  readonly elapsedPerTickMs: number;
  readonly samplesMs: readonly number[];
}

interface EventBenchmark {
  readonly gpu: readonly GpuCase[];
  readonly wasm: readonly WasmCase[];
  readonly adapter: string;
  readonly browser: {
    readonly userAgent: string;
    readonly platform: string;
    readonly logicalCpus: number;
  };
}

interface PostedResult {
  readonly pixelReactionWebGpuEventBenchmark: EventBenchmark;
}

const root = new URL("../experiments/ui-core-simd/fixtures/", import.meta.url);
const posted = await runBrowserBenchmark<PostedResult>({
  root,
  path: "/pixel-reaction-webgpu-bench.html",
  resultPath: "/__benchmark_report",
  timeoutMs: 30_000,
  profilePrefix: "jsimd-pixel-reaction-webgpu-events-",
  browserArgs: ["--enable-unsafe-webgpu"],
  validate(value): asserts value is PostedResult {
    const result = (value as Partial<PostedResult>).pixelReactionWebGpuEventBenchmark;
    if (
      result === undefined || result.gpu.length !== 6 || result.wasm.length !== 3 ||
      result.gpu.some((item) =>
        item.readbackSamplesMs.length < 90 || item.submitSamplesMs.length < 90 ||
        item.stateMismatches !== 0
      ) || result.wasm.some((item) => item.samplesMs.length < 90)
    ) throw new Error(`invalid WebGPU reaction event benchmark: ${JSON.stringify(result)}`);
  },
});
const result = posted.pixelReactionWebGpuEventBenchmark;
for (const gpu of result.gpu) {
  const wasm = result.wasm.find((item) => item.width === gpu.width)!;
  if (
    gpu.totalEvents !== gpu.retainedEvents + gpu.droppedEvents ||
    gpu.totalEvents !== wasm.totalEvents || gpu.droppedEvents !== wasm.droppedEvents
  ) throw new Error(`GPU/Wasm event mismatch at width ${gpu.width}, cadence ${gpu.cadence}`);
}

const sampleCount = Math.min(
  ...result.gpu.map((item) => item.readbackSamplesMs.length),
  ...result.gpu.map((item) => item.submitSamplesMs.length),
  ...result.wasm.map((item) => item.samplesMs.length),
);
const measurements = [
  ...result.gpu.flatMap((item) => [
    summarizeBenchmarkSamples(
      `webgpu.width${item.width}.cadence${item.cadence}.batch-completion`,
      "materialization-inclusive",
      trailing(item.readbackSamplesMs, sampleCount),
    ),
    summarizeBenchmarkSamples(
      `webgpu.width${item.width}.cadence${item.cadence}.cpu-submit`,
      "resident",
      trailing(item.submitSamplesMs, sampleCount),
    ),
  ]),
  ...result.wasm.map((item) =>
    summarizeBenchmarkSamples(
      `wasm-simd.width${item.width}.reaction-compute`,
      "resident",
      trailing(item.samplesMs, sampleCount),
    )
  ),
];
const metrics = Object.fromEntries([
  ...result.gpu.flatMap((item) => {
    const prefix = `webgpu.width${item.width}.cadence${item.cadence}`;
    return [
      [`${prefix}.elapsedPerTickMs`, item.elapsedPerTickMs],
      [`${prefix}.totalEvents`, item.totalEvents],
      [`${prefix}.droppedEvents`, item.droppedEvents],
      [`${prefix}.readbackBytes`, item.readbackBytes],
      [`${prefix}.residentBytes`, item.residentBytes],
      [`${prefix}.stagingBytes`, item.stagingBytes],
    ];
  }),
  ...result.wasm.flatMap((item) => [
    [`wasm.width${item.width}.totalEvents`, item.totalEvents],
    [`wasm.width${item.width}.residentBytes`, item.residentBytes],
    [`wasm.width${item.width}.elapsedPerTickMs`, item.elapsedPerTickMs],
  ]),
]);
const output = createBenchmarkResult({
  name: "ui-core-simd/pixel-reaction-webgpu-events",
  recordedAt: new Date().toISOString(),
  environment: {
    runtime: {
      name: "chromium",
      version: chromiumVersion(result.browser.userAgent),
      userAgent: result.browser.userAgent,
    },
    platform: result.browser.platform,
    logicalCpus: result.browser.logicalCpus,
    cpu: await detectHostCpu(),
    adapter: { description: result.adapter },
    crossOriginIsolated: true,
  },
  timing: { warmups: 40, samples: sampleCount, operationsPerSample: 1 },
  input: {
    shape: {
      widths: [256, 512, 1_024],
      cadences: [1, 4],
      capacity: 256,
      ticks: 400,
      scenario: "scaled-fire-cross-reaction-burst-v2",
    },
    bytes: Math.max(...result.gpu.map((item) => item.residentBytes + item.stagingBytes)),
  },
  correctness: {
    passed: true,
    checks: result.gpu.length,
    summary: "GPU and Wasm cells plus semantic events match at three sizes and two cadences",
  },
  measurements,
  metrics,
  notes: [
    "Cadence 1 awaits each event readback; cadence 4 keeps up to three staging maps in flight.",
    "Batch-completion is latency for the complete cadence window and is not divided by tick count.",
    "CPU-submit measures JavaScript command encoding/submission only; elapsedPerTickMs is wall throughput.",
    "The normal resident WebGPU renderer does not import this benchmark or reaction/event entrypoint.",
  ],
});

const json = JSON.stringify(output, null, 2) + "\n";
const outputPath = Deno.env.get("JSIMD_PIXEL_GPU_REACTION_EVENT_OUTPUT") ??
  "experiments/ui-core-simd/benchmarks/pixel-reaction-webgpu-events.json";
await Deno.writeTextFile(outputPath, json);
console.log(json);

function chromiumVersion(userAgent: string): string {
  const match = /(?:Chrome|Chromium)\/([0-9.]+)/.exec(userAgent);
  return match?.[1] ?? "unknown";
}

function trailing(values: readonly number[], count: number): readonly number[] {
  return values.slice(values.length - count);
}
