export const memory: WebAssembly.Memory;
export function squared_distance_many(
  vectors: number,
  query: number,
  count: number,
  dimensions: number,
  output: number,
): void;
export function l1_distance_many(
  vectors: number,
  query: number,
  count: number,
  dimensions: number,
  output: number,
): void;
export function inner_product_many(
  vectors: number,
  query: number,
  count: number,
  dimensions: number,
  output: number,
): void;
export function top_k(
  vectors: number,
  query: number,
  count: number,
  dimensions: number,
  scratch: number,
  outputIds: number,
  outputDistances: number,
  k: number,
): void;
export function top_k_inner_product(
  vectors: number,
  query: number,
  count: number,
  dimensions: number,
  scratch: number,
  outputIds: number,
  outputProducts: number,
  k: number,
): void;
