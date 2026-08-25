export const memory: WebAssembly.Memory;
export function match_mask(group: number, fingerprint: number): number;
export function empty_mask(group: number): number;
export function deleted_mask(group: number): number;
export function match_many(
  group: number,
  fingerprints: number,
  output: number,
  length: number,
): void;
export function table_probe_many(
  controls: number,
  capacity: number,
  hashes: number,
  groupOffsets: number,
  matches: number,
  empty: number,
  deleted: number,
  length: number,
): void;
