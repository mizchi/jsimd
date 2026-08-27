export const memory: WebAssembly.Memory;
export function add(target: number, source: number, storageLength: number): void;
export function scale(target: number, storageLength: number, factor: number): void;
export function batched_matmul(
  left: number,
  right: number,
  output: number,
  batches: number,
  rows: number,
  inner: number,
  outputStride: number,
  leftStride: number,
): void;
