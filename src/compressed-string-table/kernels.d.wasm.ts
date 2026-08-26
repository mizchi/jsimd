export const memory: WebAssembly.Memory;
export function decode(
  anchorOffsets: number,
  prefixLengths: number,
  suffixOffsets: number,
  suffixLengths: number,
  arena: number,
  id: number,
  output: number,
): number;
export function equals(
  anchorOffsets: number,
  prefixLengths: number,
  suffixOffsets: number,
  suffixLengths: number,
  arena: number,
  id: number,
  query: number,
  queryLength: number,
): number;
export function equals_many(
  anchorOffsets: number,
  prefixLengths: number,
  suffixOffsets: number,
  suffixLengths: number,
  arena: number,
  ids: number,
  queries: number,
  offsets: number,
  count: number,
  output: number,
): void;
