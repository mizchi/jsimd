import type { PixelRegion, PixelRuntime, PixelWidth } from "./pixel_options.ts";

export interface PixelBenchmarkCase {
  readonly runtime: PixelRuntime;
  readonly width: PixelWidth;
  readonly occupancy: number;
  readonly region: PixelRegion;
}

export const DEFAULT_PIXEL_WIDTHS: readonly PixelWidth[] = [256, 512, 1_024];
export const DEFAULT_PIXEL_OCCUPANCIES: readonly number[] = [0.05, 0.25, 0.75];
export const DEFAULT_PIXEL_RUNTIMES: readonly PixelRuntime[] = [
  "cpu",
  "block",
  "block-active",
  "block-simd",
  "block-active-simd",
  "active",
  "worker",
  "worker-simd",
  "webgpu",
];
export const DEFAULT_PIXEL_REGIONS: readonly PixelRegion[] = ["full", "spot"];

export function createPixelBenchmarkCases(
  widths: readonly number[] = DEFAULT_PIXEL_WIDTHS,
  occupancies: readonly number[] = DEFAULT_PIXEL_OCCUPANCIES,
  runtimes: readonly PixelRuntime[] = DEFAULT_PIXEL_RUNTIMES,
  regions: readonly PixelRegion[] = DEFAULT_PIXEL_REGIONS,
): readonly PixelBenchmarkCase[] {
  if (
    widths.length === 0 || occupancies.length === 0 || runtimes.length === 0 || regions.length === 0
  ) {
    throw new RangeError("pixel benchmark axes must not be empty");
  }
  const cases: PixelBenchmarkCase[] = [];
  for (const width of widths) {
    if (width !== 256 && width !== 512 && width !== 1_024) {
      throw new RangeError(`unsupported pixel benchmark width: ${width}`);
    }
    for (const region of regions) {
      for (const occupancy of occupancies) {
        if (occupancy !== 0.05 && occupancy !== 0.25 && occupancy !== 0.75) {
          throw new RangeError(`unsupported pixel benchmark occupancy: ${occupancy}`);
        }
        for (const runtime of runtimes) cases.push({ runtime, width, occupancy, region });
      }
    }
  }
  return cases;
}
