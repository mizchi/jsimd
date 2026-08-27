export const memory: WebAssembly.Memory;
export function lookup(
  displacements: number,
  fingerprints: number,
  bucketCount: number,
  length: number,
  key: number,
): number;
export function lookup_many(
  displacements: number,
  fingerprints: number,
  bucketCount: number,
  length: number,
  queries: number,
  queryCount: number,
  output: number,
): number;
