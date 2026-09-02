/** Converts a Worker presentation timestamp to latency from a main-thread u32 event timestamp. */
export function inputToPresentMicros(
  mainTimeOriginMillis: number,
  workerTimeOriginMillis: number,
  workerNowMillis: number,
  inputTimeMicros: number,
): number {
  const presentedSinceMainOrigin =
    (workerTimeOriginMillis - mainTimeOriginMillis) + workerNowMillis;
  const presentedMicros = Math.round(presentedSinceMainOrigin * 1_000) >>> 0;
  return (presentedMicros - (inputTimeMicros >>> 0)) >>> 0;
}
