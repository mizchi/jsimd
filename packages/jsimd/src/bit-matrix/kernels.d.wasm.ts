export const memory: WebAssembly.Memory;
export function row_count(row: number, paddedWords: number): number;
export function transpose(
  input: number,
  output: number,
  rows: number,
  columns: number,
  inputStrideWords: number,
  outputStrideWords: number,
): void;
export function boolean_multiply(
  left: number,
  rightTransposed: number,
  output: number,
  rows: number,
  columns: number,
  sharedPaddedWords: number,
  leftStrideWords: number,
  rightStrideWords: number,
  outputStrideWords: number,
): void;
export function sparse_has(
  offsets: number,
  values: number,
  row: number,
  target: number,
): number;
