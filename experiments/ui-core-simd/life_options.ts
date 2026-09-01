export type LifeRuntime = "scalar" | "simd";
export type LifeRenderer = "main" | "offscreen";
export type LifeRendererPreference = LifeRenderer | "auto";

/** Initial crossover estimate; public so applications can inspect or replace this policy. */
export const LIFE_OFFSCREEN_MIN_CELLS = 262_144;
export const LIFE_MAX_MAIN_LOAD_MS = 8;

export function parseLifeMainLoadMs(value: string | null): number {
  if (value === null) return 0;
  const milliseconds = Number(value);
  if (
    !Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > LIFE_MAX_MAIN_LOAD_MS
  ) {
    throw new RangeError(`Life main-thread load must be between 0 and ${LIFE_MAX_MAIN_LOAD_MS} ms`);
  }
  return milliseconds;
}

export function selectLifeRenderer(
  preference: LifeRendererPreference,
  cellCount: number,
  offscreenAvailable: boolean,
): LifeRenderer {
  if (!Number.isSafeInteger(cellCount) || cellCount <= 0) {
    throw new RangeError("Life renderer cell count must be a positive safe integer");
  }
  if (preference === "main" || !offscreenAvailable) return "main";
  if (preference === "offscreen") return "offscreen";
  return cellCount >= LIFE_OFFSCREEN_MIN_CELLS ? "offscreen" : "main";
}
