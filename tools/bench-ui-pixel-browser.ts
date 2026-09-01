import { detectHostCpu, runBrowserBenchmark } from "../packages/bench/src/browser_runner.ts";
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
  readonly frameGapP95Ms: number;
  readonly mainFrameMedianMs: number;
  readonly paintFps: number;
  readonly residentBytes: number;
  readonly adapter: string;
  readonly mainLoadMs: number;
  readonly activeChunks: number;
  readonly chunkCount: number;
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

const output = {
  schema: "jsimd.pixel-browser.v2",
  capturedAt: new Date().toISOString(),
  cpu: await detectHostCpu(),
  results,
};
const json = JSON.stringify(output, null, 2) + "\n";
const outputPath = Deno.env.get("JSIMD_PIXEL_OUTPUT");
if (outputPath !== undefined) await Deno.writeTextFile(outputPath, json);
console.log(json);

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
    if (item !== "cpu" && item !== "active" && item !== "worker" && item !== "webgpu") {
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
    (pixel.runtime !== "cpu" && pixel.runtime !== "active" && pixel.runtime !== "worker" &&
      pixel.runtime !== "webgpu") ||
    !("tickMedianMs" in pixel) || typeof pixel.tickMedianMs !== "number"
  ) {
    throw new TypeError("pixel browser result is invalid");
  }
}
