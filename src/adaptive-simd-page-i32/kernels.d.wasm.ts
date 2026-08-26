export const memory: WebAssembly.Memory;
export function decode_raw(input: number, output: number, length: number): void;
export function decode_for(
  packed: number,
  output: number,
  length: number,
  bitWidth: number,
  base: number,
): void;
export function decode_rle(runs: number, output: number, runCount: number): void;
export function decode_dictionary(
  dictionary: number,
  codes: number,
  output: number,
  length: number,
): void;
export function decode_sparse(
  positions: number,
  values: number,
  output: number,
  length: number,
  exceptionCount: number,
  defaultValue: number,
): void;
export function sum_raw(input: number, length: number): bigint;
export function sum_for(packed: number, length: number, bitWidth: number, base: number): bigint;
export function sum_rle(runs: number, runCount: number): bigint;
export function sum_dictionary(dictionary: number, cardinality: number): bigint;
export function sum_sparse(
  values: number,
  length: number,
  exceptionCount: number,
  defaultValue: number,
): bigint;
export function scan_eq_raw(input: number, output: number, length: number, value: number): void;
export function scan_eq_for(
  packed: number,
  output: number,
  length: number,
  bitWidth: number,
  base: number,
  value: number,
): void;
export function scan_eq_rle(
  runs: number,
  output: number,
  runCount: number,
  value: number,
): void;
export function scan_eq_dictionary(
  dictionary: number,
  codes: number,
  output: number,
  length: number,
  cardinality: number,
  value: number,
): void;
export function scan_eq_sparse(
  positions: number,
  values: number,
  output: number,
  length: number,
  exceptionCount: number,
  defaultValue: number,
  target: number,
): void;
export function scan_lt_raw(input: number, output: number, length: number, value: number): void;
export function scan_lt_for(
  packed: number,
  output: number,
  length: number,
  bitWidth: number,
  base: number,
  value: number,
): void;
export function scan_lt_rle(
  runs: number,
  output: number,
  runCount: number,
  value: number,
): void;
export function scan_lt_dictionary(
  dictionary: number,
  codes: number,
  output: number,
  length: number,
  cardinality: number,
  value: number,
): void;
export function scan_lt_sparse(
  positions: number,
  values: number,
  output: number,
  length: number,
  exceptionCount: number,
  defaultValue: number,
  target: number,
): void;
export function scan_between_raw(
  input: number,
  output: number,
  length: number,
  minimum: number,
  maximum: number,
): void;
export function scan_between_for(
  packed: number,
  output: number,
  length: number,
  bitWidth: number,
  base: number,
  minimum: number,
  maximum: number,
): void;
export function scan_between_rle(
  runs: number,
  output: number,
  runCount: number,
  minimum: number,
  maximum: number,
): void;
export function scan_between_dictionary(
  dictionary: number,
  codes: number,
  output: number,
  length: number,
  cardinality: number,
  minimum: number,
  maximum: number,
): void;
export function scan_between_sparse(
  positions: number,
  values: number,
  output: number,
  length: number,
  exceptionCount: number,
  defaultValue: number,
  minimum: number,
  maximum: number,
): void;
export function gather_raw(
  input: number,
  mask: number,
  output: number,
  length: number,
): number;
export function gather_for(
  packed: number,
  mask: number,
  output: number,
  length: number,
  bitWidth: number,
  base: number,
): number;
export function gather_rle(
  runs: number,
  mask: number,
  output: number,
  runCount: number,
): number;
export function gather_dictionary(
  dictionary: number,
  codes: number,
  mask: number,
  output: number,
  length: number,
): number;
export function gather_sparse(
  positions: number,
  values: number,
  mask: number,
  output: number,
  length: number,
  exceptionCount: number,
  defaultValue: number,
): number;
export function mask_and(left: number, right: number, wordCount: number): void;
export function mask_or(left: number, right: number, wordCount: number): void;
export function mask_andnot(left: number, right: number, wordCount: number): void;
export function mask_not(pointer: number, wordCount: number): void;
export function mask_count(pointer: number, wordCount: number): number;
