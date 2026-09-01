const WASM_PAGE_BYTES = 65_536;

export interface PackedGraphMemoryEstimate {
  readonly denseMatrixBytes: number;
  readonly wasmMemoryBytes: number;
  readonly typedArrayBytes: number;
  readonly totalBytes: number;
}

export function estimatePackedGraphMemory(
  signalCount: number,
  effectCount: number,
  subscriptionCount: number,
  denseSignalCount = signalCount,
): PackedGraphMemoryEstimate {
  for (
    const [name, value] of [
      ["signalCount", signalCount],
      ["effectCount", effectCount],
      ["subscriptionCount", subscriptionCount],
      ["denseSignalCount", denseSignalCount],
    ] as const
  ) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} out of range`);
  }
  if (denseSignalCount > signalCount) throw new RangeError("denseSignalCount out of range");
  const paddedWords = alignTo(Math.ceil(effectCount / 32), 4);
  const denseMatrixBytes = denseSignalCount * paddedWords * 4;
  const signalIds = alignTo(denseMatrixBytes, 16);
  const output = alignTo(signalIds + denseSignalCount * 4, 16);
  const wasmMemoryBytes = Math.max(1, Math.ceil((output + paddedWords * 4) / WASM_PAGE_BYTES)) *
    WASM_PAGE_BYTES;
  const typedArrayBytes = (effectCount * 2 + subscriptionCount + signalCount) * 4;
  return {
    denseMatrixBytes,
    wasmMemoryBytes,
    typedArrayBytes,
    totalBytes: wasmMemoryBytes + typedArrayBytes,
  };
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
