/** Converts a Worker presentation timestamp to latency from a main-thread u32 event timestamp. */
export function inputToPresentMicros(
  mainTimeOriginMillis: number,
  workerTimeOriginMillis: number,
  workerNowMillis: number,
  inputTimeMicros: number,
): number {
  const presentedSinceMainOrigin = (workerTimeOriginMillis - mainTimeOriginMillis) +
    workerNowMillis;
  const presentedMicros = Math.round(presentedSinceMainOrigin * 1_000) >>> 0;
  return (presentedMicros - (inputTimeMicros >>> 0)) >>> 0;
}

/** Returns an epoch-relative microsecond timestamp modulo 2^32 for cross-agent comparisons. */
export function timelineMicros(timeOriginMillis: number, nowMillis: number): number {
  if (!Number.isFinite(timeOriginMillis) || !Number.isFinite(nowMillis)) {
    throw new TypeError("timeline inputs must be finite");
  }
  return Math.round((timeOriginMillis + nowMillis) * 1_000) >>> 0;
}

/** Computes a short elapsed interval between wrapping u32 microsecond timestamps. */
export function elapsedUint32Micros(nowMicros: number, thenMicros: number): number {
  return ((nowMicros >>> 0) - (thenMicros >>> 0)) >>> 0;
}
