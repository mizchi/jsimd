export const memory: WebAssembly.Memory;
export function build_rank_index(
  highBits: number,
  rankIndex: number,
  paddedWords: number,
  superblocks: number,
): number;
export function at(
  highBits: number,
  rankIndex: number,
  lowBits: number,
  paddedWords: number,
  superblocks: number,
  lowerBits: number,
  index: number,
): number;
export function lower_bound(
  highBits: number,
  rankIndex: number,
  lowBits: number,
  paddedWords: number,
  superblocks: number,
  highLength: number,
  length: number,
  lowerBits: number,
  zeroCount: number,
  value: number,
): number;
export function at_many(
  highBits: number,
  rankIndex: number,
  lowBits: number,
  paddedWords: number,
  superblocks: number,
  lowerBits: number,
  indices: number,
  output: number,
  count: number,
): void;
export function lower_bound_many(
  highBits: number,
  rankIndex: number,
  lowBits: number,
  paddedWords: number,
  superblocks: number,
  highLength: number,
  length: number,
  lowerBits: number,
  zeroCount: number,
  values: number,
  output: number,
  count: number,
): void;
export function decode_into(
  highBits: number,
  lowBits: number,
  lowerBits: number,
  length: number,
  output: number,
): void;
