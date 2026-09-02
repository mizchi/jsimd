export type PixelRuntime =
  | "cpu"
  | "block"
  | "block-active"
  | "block-simd"
  | "block-active-simd"
  | "active"
  | "worker"
  | "worker-simd"
  | "worker-reaction-simd"
  | "block-webgpu"
  | "webgpu";
export type PixelWidth = 256 | 512 | 1_024;
export type PixelOccupancyPercent = 5 | 25 | 75;
export type PixelRegion = "full" | "quarter" | "spot";

export function parsePixelRuntime(value: string | null): PixelRuntime {
  if (value === null || value === "worker-reaction-simd") return "worker-reaction-simd";
  if (value === "cpu") return "cpu";
  if (
    value === "block" || value === "block-active" || value === "block-simd" ||
    value === "block-active-simd" ||
    value === "active" || value === "worker" || value === "worker-simd" ||
    value === "worker-reaction-simd" || value === "block-webgpu" || value === "webgpu"
  ) {
    return value;
  }
  throw new TypeError(`unknown pixel runtime: ${value}`);
}

export function parsePixelRegion(value: string | null): PixelRegion {
  if (value === null || value === "full") return "full";
  if (value === "quarter" || value === "spot") return value;
  throw new TypeError(`unknown pixel region: ${value}`);
}

export function parsePixelWidth(value: string | null): PixelWidth {
  const width = value === null ? 512 : Number(value);
  if (width === 256 || width === 512 || width === 1_024) return width;
  throw new RangeError(`unsupported pixel width: ${value}`);
}

export function parsePixelOccupancy(value: string | null): number {
  const percent = value === null ? 25 : Number(value);
  if (percent === 5 || percent === 25 || percent === 75) return percent / 100;
  throw new RangeError(`unsupported pixel occupancy: ${value}`);
}
