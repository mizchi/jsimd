export const memory: WebAssembly.Memory;
export function lookup(
  displacements: number,
  bucketCount: number,
  offsets: number,
  lengths: number,
  count: number,
  arena: number,
  key: number,
  keyLength: number,
): number;
export function lookup_many(
  displacements: number,
  bucketCount: number,
  offsets: number,
  lengths: number,
  count: number,
  arena: number,
  queries: number,
  queryOffsets: number,
  queryCount: number,
  output: number,
): number;
export function lookup_values_many(
  displacements: number,
  bucketCount: number,
  offsets: number,
  lengths: number,
  count: number,
  arena: number,
  values: number,
  queries: number,
  queryOffsets: number,
  queryCount: number,
  outputValues: number,
  present: number,
): number;
