export const memory: WebAssembly.Memory;
export function build(
  input: number,
  scratch: number,
  bits: number,
  ranks: number,
  zeros: number,
  length: number,
  paddedWords: number,
  superblocks: number,
): void;
export function access(
  bits: number,
  ranks: number,
  zeros: number,
  paddedWords: number,
  superblocks: number,
  index: number,
): number;
export function rank(
  bits: number,
  ranks: number,
  zeros: number,
  paddedWords: number,
  superblocks: number,
  value: number,
  end: number,
): number;
export function select(
  bits: number,
  ranks: number,
  zeros: number,
  paddedWords: number,
  superblocks: number,
  length: number,
  value: number,
  occurrence: number,
): number;
export function count_lt(
  bits: number,
  ranks: number,
  zeros: number,
  paddedWords: number,
  superblocks: number,
  left: number,
  right: number,
  value: number,
): number;
export function quantile(
  bits: number,
  ranks: number,
  zeros: number,
  paddedWords: number,
  superblocks: number,
  left: number,
  right: number,
  kth: number,
): number;
export function access_many(
  bits: number,
  ranks: number,
  zeros: number,
  paddedWords: number,
  superblocks: number,
  indices: number,
  output: number,
  count: number,
): void;
export function rank_many(
  bits: number,
  ranks: number,
  zeros: number,
  paddedWords: number,
  superblocks: number,
  values: number,
  ends: number,
  output: number,
  count: number,
): void;
export function quantile_many(
  bits: number,
  ranks: number,
  zeros: number,
  paddedWords: number,
  superblocks: number,
  lefts: number,
  rights: number,
  kths: number,
  output: number,
  count: number,
): void;
