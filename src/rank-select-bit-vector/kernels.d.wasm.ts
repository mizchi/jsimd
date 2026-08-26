export const memory: WebAssembly.Memory;
export function build_rank_index(
  bits: number,
  rankIndex: number,
  paddedWords: number,
  superblocks: number,
): number;
export function rank1(bits: number, rankIndex: number, end: number): number;
export function rank1_many(
  bits: number,
  rankIndex: number,
  ends: number,
  output: number,
  count: number,
): void;
export function rank0_many(
  bits: number,
  rankIndex: number,
  ends: number,
  output: number,
  count: number,
): void;
export function select1(
  bits: number,
  rankIndex: number,
  paddedWords: number,
  superblocks: number,
  rank: number,
): number;
export function select1_many(
  bits: number,
  rankIndex: number,
  paddedWords: number,
  superblocks: number,
  ranks: number,
  output: number,
  count: number,
): void;
export function select0(
  bits: number,
  rankIndex: number,
  paddedWords: number,
  superblocks: number,
  length: number,
  rank: number,
): number;
export function select0_many(
  bits: number,
  rankIndex: number,
  paddedWords: number,
  superblocks: number,
  length: number,
  ranks: number,
  output: number,
  count: number,
): void;
export function next1(
  bits: number,
  rankIndex: number,
  paddedWords: number,
  superblocks: number,
  countOnes: number,
  length: number,
  position: number,
): number;
export function prev1(
  bits: number,
  rankIndex: number,
  paddedWords: number,
  superblocks: number,
  countOnes: number,
  length: number,
  position: number,
): number;
export function next0(
  bits: number,
  rankIndex: number,
  paddedWords: number,
  superblocks: number,
  countZeros: number,
  length: number,
  position: number,
): number;
export function prev0(
  bits: number,
  rankIndex: number,
  paddedWords: number,
  superblocks: number,
  countZeros: number,
  length: number,
  position: number,
): number;
