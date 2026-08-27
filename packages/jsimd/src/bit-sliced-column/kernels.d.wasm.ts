export const memory: WebAssembly.Memory;
export function scan_eq(
  planes: number,
  validity: number,
  output: number,
  wordCount: number,
  bitWidth: number,
  value: number,
): void;
export function scan_lt(
  planes: number,
  validity: number,
  output: number,
  wordCount: number,
  bitWidth: number,
  value: number,
): void;
export function scan_between(
  planes: number,
  validity: number,
  output: number,
  wordCount: number,
  bitWidth: number,
  minimum: number,
  maximumExclusive: number,
): void;
export function mask_and(left: number, right: number, wordCount: number): void;
export function mask_or(left: number, right: number, wordCount: number): void;
export function mask_andnot(left: number, right: number, wordCount: number): void;
export function mask_count(pointer: number, wordCount: number): number;
