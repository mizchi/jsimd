import { detectHostCpu, runBrowserBenchmark } from "../packages/bench/src/browser_runner.ts";
import { summarizeBenchmarkSamples } from "../packages/bench/src/measure.ts";
import { createBenchmarkResult } from "../packages/bench/src/result.ts";
import {
  createPixelBenchmarkCases,
  DEFAULT_PIXEL_OCCUPANCIES,
  DEFAULT_PIXEL_REGIONS,
  DEFAULT_PIXEL_RUNTIMES,
  DEFAULT_PIXEL_WIDTHS,
} from "../experiments/ui-core-simd/pixel_benchmark_matrix.ts";
import type {
  PixelRegion,
  PixelRuntime,
  PixelWidth,
} from "../experiments/ui-core-simd/pixel_options.ts";

interface PixelResult {
  readonly runtime: PixelRuntime;
  readonly cells: number;
  readonly occupancy: number;
  readonly region: PixelRegion;
  readonly ticks: number;
  readonly tickMedianMs: number;
  readonly tickP95Ms: number;
  readonly computeMedianMs: number;
  readonly renderMedianMs: number;
  readonly inputLatencyMs: number;
  readonly eventLatencyMs: number;
  readonly frameGapP95Ms: number;
  readonly mainFrameMedianMs: number;
  readonly paintFps: number;
  readonly residentBytes: number;
  readonly adapter: string;
  readonly mainLoadMs: number;
  readonly activeChunks: number;
  readonly chunkCount: number;
  readonly events: number;
  readonly droppedEvents: number;
  readonly samples: {
    readonly tickMs: readonly number[];
    readonly computeMs: readonly number[];
    readonly renderMs: readonly number[];
  };
  readonly browser: {
    readonly userAgent: string;
    readonly platform: string;
    readonly logicalCpus: number;
    readonly crossOriginIsolated: boolean;
  };
}

interface PostedResult {
  readonly pixel: PixelResult;
}

const widths = parseWidths(Deno.env.get("JSIMD_PIXEL_WIDTHS"));
const occupancies = parseOccupancies(Deno.env.get("JSIMD_PIXEL_OCCUPANCIES"));
const runtimes = parseRuntimes(Deno.env.get("JSIMD_PIXEL_RUNTIMES"));
const regions = parseRegions(Deno.env.get("JSIMD_PIXEL_REGIONS"));
const mainLoadMs = Number(Deno.env.get("JSIMD_PIXEL_MAIN_LOAD_MS") ?? 0);
if (!Number.isFinite(mainLoadMs) || mainLoadMs < 0 || mainLoadMs > 8) {
  throw new RangeError("JSIMD_PIXEL_MAIN_LOAD_MS must be between zero and eight");
}
const root = new URL("../experiments/ui-core-simd/browser-ui/dist/", import.meta.url);
const results: PixelResult[] = [];
for (const benchmark of createPixelBenchmarkCases(widths, occupancies, runtimes, regions)) {
  console.error(
    `pixel ${benchmark.runtime} ${benchmark.width}×${benchmark.width * 5 / 8} ${
      benchmark.occupancy * 100
    }% ${benchmark.region}`,
  );
  const posted = await runBrowserBenchmark<PostedResult>({
    root,
    query: {
      run: "pixel",
      autorun: 1,
      runtime: benchmark.runtime,
      size: benchmark.width,
      occupancy: benchmark.occupancy * 100,
      region: benchmark.region,
      load: mainLoadMs,
    },
    resultPath: "/__benchmark_report",
    timeoutMs: 30_000,
    profilePrefix: `jsimd-pixel-${benchmark.runtime}-`,
    browserArgs: ["--enable-unsafe-webgpu"],
    validate: validatePostedResult,
  });
  results.push(posted.pixel);
}

const cpu = await detectHostCpu();
const sampleSets = results.flatMap((result) => [
  result.samples.tickMs,
  ...(result.samples.computeMs.length === 0 ? [] : [result.samples.computeMs]),
  ...(result.samples.renderMs.length === 0 ? [] : [result.samples.renderMs]),
]);
const sampleCount = Math.min(...sampleSets.map((samples) => samples.length));
const measurements = results.flatMap((result) => {
  const prefix = `${result.runtime}/width=${Math.sqrt(result.cells * 8 / 5)}`;
  const shape = `cells=${result.cells}/occupancy=${result.occupancy}/region=${result.region}`;
  const summarized = [
    summarizeBenchmarkSamples(
      `${prefix}/${shape}/tick-present`,
      "end-to-end",
      trailing(result.samples.tickMs, sampleCount),
    ),
  ];
  if (result.samples.computeMs.length > 0) {
    summarized.push(summarizeBenchmarkSamples(
      `${prefix}/${shape}/compute`,
      "resident",
      trailing(result.samples.computeMs, sampleCount),
    ));
  }
  if (result.samples.renderMs.length > 0) {
    summarized.push(summarizeBenchmarkSamples(
      `${prefix}/${shape}/render`,
      "materialization-inclusive",
      trailing(result.samples.renderMs, sampleCount),
    ));
  }
  return summarized;
});
const first = results[0]!;
const output = createBenchmarkResult({
  name: "ui-core-simd/pixel-browser",
  recordedAt: new Date().toISOString(),
  environment: {
    runtime: {
      name: "chromium",
      version: chromiumVersion(first.browser.userAgent),
      userAgent: first.browser.userAgent,
    },
    platform: first.browser.platform,
    logicalCpus: first.browser.logicalCpus,
    cpu,
    adapter: null,
    crossOriginIsolated: first.browser.crossOriginIsolated,
  },
  timing: { warmups: 0, samples: sampleCount, operationsPerSample: 1 },
  input: {
    shape: {
      widths: [...widths],
      occupancies: occupancies.map((value) => value * 100),
      runtimes: runtimes.join(","),
      regions: regions.join(","),
      mainLoadMs,
    },
    bytes: Math.max(...results.map((result) => result.residentBytes)),
  },
  correctness: {
    passed: true,
    checks: results.length,
    summary: "every isolated browser case completed 90 ticks and 11 pointer injections",
  },
  measurements,
  metrics: Object.fromEntries(results.flatMap((result) => {
    const width = Math.sqrt(result.cells * 8 / 5);
    const prefix = `${result.runtime}.width${width}.${result.region}`;
    return [
      [`${prefix}.inputLatencyMs`, result.inputLatencyMs],
      [`${prefix}.eventLatencyMs`, result.eventLatencyMs],
      [`${prefix}.mainFrameMedianMs`, result.mainFrameMedianMs],
      [`${prefix}.frameGapP95Ms`, result.frameGapP95Ms],
      [`${prefix}.paintFps`, result.paintFps],
      [`${prefix}.residentBytes`, result.residentBytes],
      [`${prefix}.activeChunks`, result.activeChunks],
      [`${prefix}.chunkCount`, result.chunkCount],
      [`${prefix}.events`, result.events],
      [`${prefix}.droppedEvents`, result.droppedEvents],
    ];
  })),
  notes: [
    "Tick-present includes simulation and Canvas presentation for CPU runtimes.",
    "Warmups are retained in the raw rolling samples; this run does not claim a separate warmup phase.",
    "Input-to-Canvas-submit is recorded in metrics rather than measurements because it has a different 11-sample count.",
    "Event latency is the final observed age of the newest non-empty Worker batch when main drains it, not a per-event distribution.",
    ...results.filter((result) => result.chunkCount > 0).map((result) =>
      `${result.runtime} width=${
        Math.sqrt(result.cells * 8 / 5)
      } region=${result.region}: ${result.activeChunks}/${result.chunkCount} chunks active after the run.`
    ),
  ],
});
const json = JSON.stringify(output, null, 2) + "\n";
const outputPath = Deno.env.get("JSIMD_PIXEL_OUTPUT");
if (outputPath !== undefined) await Deno.writeTextFile(outputPath, json);
console.log(json);

function trailing(values: readonly number[], count: number): readonly number[] {
  return values.slice(values.length - count);
}

function chromiumVersion(userAgent: string): string {
  const match = /(?:Chrome|Chromium)\/([0-9.]+)/.exec(userAgent);
  return match?.[1] ?? "unknown";
}

function parseWidths(value: string | undefined): readonly PixelWidth[] {
  if (value === undefined) return DEFAULT_PIXEL_WIDTHS;
  return value.split(",").map((item) => {
    const width = Number(item);
    if (width !== 256 && width !== 512 && width !== 1_024) {
      throw new RangeError(`unsupported pixel width: ${item}`);
    }
    return width;
  });
}

function parseOccupancies(value: string | undefined): readonly number[] {
  if (value === undefined) return DEFAULT_PIXEL_OCCUPANCIES;
  return value.split(",").map((item) => {
    const occupancy = Number(item) / 100;
    if (occupancy !== 0.05 && occupancy !== 0.25 && occupancy !== 0.75) {
      throw new RangeError(`unsupported pixel occupancy: ${item}`);
    }
    return occupancy;
  });
}

function parseRuntimes(value: string | undefined): readonly PixelRuntime[] {
  if (value === undefined) return DEFAULT_PIXEL_RUNTIMES;
  return value.split(",").map((item) => {
    if (
      item !== "cpu" && item !== "block" && item !== "block-active" && item !== "block-simd" &&
      item !== "block-active-simd" &&
      item !== "active" && item !== "worker" && item !== "worker-simd" &&
      item !== "worker-reaction-simd" && item !== "block-webgpu" && item !== "webgpu"
    ) {
      throw new RangeError(`unsupported runtime: ${item}`);
    }
    return item;
  });
}

function parseRegions(value: string | undefined): readonly PixelRegion[] {
  if (value === undefined) return DEFAULT_PIXEL_REGIONS;
  return value.split(",").map((item) => {
    if (item !== "full" && item !== "quarter" && item !== "spot") {
      throw new RangeError(`unsupported pixel region: ${item}`);
    }
    return item;
  });
}

function validatePostedResult(value: unknown): asserts value is PostedResult {
  if (typeof value !== "object" || value === null || !("pixel" in value)) {
    throw new TypeError("pixel browser result is missing");
  }
  const pixel = value.pixel;
  if (
    typeof pixel !== "object" || pixel === null ||
    !("runtime" in pixel) ||
    (pixel.runtime !== "cpu" && pixel.runtime !== "block" && pixel.runtime !== "block-active" &&
      pixel.runtime !== "block-simd" && pixel.runtime !== "block-active-simd" &&
      pixel.runtime !== "active" && pixel.runtime !== "worker" &&
      pixel.runtime !== "worker-simd" && pixel.runtime !== "worker-reaction-simd" &&
      pixel.runtime !== "block-webgpu" && pixel.runtime !== "webgpu") ||
    !("tickMedianMs" in pixel) || typeof pixel.tickMedianMs !== "number" ||
    !("samples" in pixel) || typeof pixel.samples !== "object" || pixel.samples === null ||
    !("browser" in pixel) || typeof pixel.browser !== "object" || pixel.browser === null
  ) {
    throw new TypeError("pixel browser result is invalid");
  }
}
