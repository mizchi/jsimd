export const memory: WebAssembly.Memory;
export function distance_many(
  vectors: number,
  query: number,
  count: number,
  stride: number,
  output: number,
): void;
export function pdx_distance_many(
  vectors: number,
  query: number,
  count: number,
  dimensions: number,
  output: number,
): void;
export function pdx_distance_selected(
  vectors: number,
  query: number,
  ids: number,
  count: number,
  dimensions: number,
  output: number,
): void;
