import { detectHostCpu, runBrowserBenchmark } from "../packages/bench/src/browser_runner.ts";
import { summarizeBenchmarkSamples } from "../packages/bench/src/measure.ts";
import { createBenchmarkResult } from "../packages/bench/src/result.ts";

interface EventBenchmark {
  readonly width: number;
  readonly height: number;
  readonly capacity: number;
  readonly ticks: number;
  readonly totalEvents: number;
  readonly retainedEvents: number;
  readonly droppedEvents: number;
  readonly residentBytes: number;
  readonly readbackBytesPerTick: number;
  readonly adapter: string;
  readonly samplesMs: readonly number[];
  readonly browser: {
    readonly userAgent: string;
    readonly platform: string;
    readonly logicalCpus: number;
  };
}

interface PostedResult {
  readonly pixelBlockWebGpuEventBenchmark: EventBenchmark;
}

const root = new URL("../experiments/ui-core-simd/browser-ui/dist/", import.meta.url);
const posted = await runBrowserBenchmark<PostedResult>({
  root,
  query: { run: "pixel-block-webgpu-event-bench" },
  resultPath: "/__benchmark_report",
  timeoutMs: 30_000,
  profilePrefix: "jsimd-pixel-block-webgpu-events-",
  browserArgs: ["--enable-unsafe-webgpu"],
  validate(value): asserts value is PostedResult {
    const result = (value as Partial<PostedResult>).pixelBlockWebGpuEventBenchmark;
    if (result === undefined || result.samplesMs.length !== 90 || result.totalEvents <= 0) {
      throw new Error(`invalid WebGPU event benchmark: ${JSON.stringify(result)}`);
    }
  },
});
const result = posted.pixelBlockWebGpuEventBenchmark;
if (result.totalEvents !== result.retainedEvents + result.droppedEvents) {
  throw new Error("GPU event accounting invariant failed");
}
const output = createBenchmarkResult({
  name: "ui-core-simd/pixel-block-webgpu-events",
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
  timing: { warmups: 10, samples: result.samplesMs.length, operationsPerSample: 1 },
  input: {
    shape: {
      width: result.width,
      height: result.height,
      capacity: result.capacity,
      ticks: result.ticks,
    },
    bytes: result.residentBytes,
  },
  correctness: {
    passed: true,
    checks: result.ticks,
    summary: "bounded append count equals retained capacity plus observable drops per dense tick",
  },
  measurements: [summarizeBenchmarkSamples(
    "compute-and-event-readback",
    "materialization-inclusive",
    result.samplesMs,
  )],
  metrics: {
    totalEvents: result.totalEvents,
    retainedEvents: result.retainedEvents,
    droppedEvents: result.droppedEvents,
    readbackBytesPerTick: result.readbackBytesPerTick,
    residentBytes: result.residentBytes,
  },
  notes: [
    "The normal resident WebGPU renderer does not import this event-enabled entrypoint.",
    "Each synchronized sample includes one conservative 2x2 compute step and one bounded staging-buffer map.",
  ],
});

const json = JSON.stringify(output, null, 2) + "\n";
const outputPath = Deno.env.get("JSIMD_PIXEL_GPU_EVENT_OUTPUT") ??
  "experiments/ui-core-simd/benchmarks/pixel-block-webgpu-events.json";
await Deno.writeTextFile(outputPath, json);
console.log(json);

function chromiumVersion(userAgent: string): string {
  const match = /(?:Chrome|Chromium)\/([0-9.]+)/.exec(userAgent);
  return match?.[1] ?? "unknown";
}
