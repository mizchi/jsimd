export const memory: WebAssembly.Memory;
export function find_byte(pointer: number, length: number, needle: number): number;
export function reverse_find_byte(pointer: number, length: number, needle: number): number;
export function find_non_ascii(pointer: number, length: number): number;
export function bytes_equal(left: number, right: number, length: number): number;
export function lexical_compare_prefix(left: number, right: number, length: number): number;
export function index_of_subarray(
  haystack: number,
  haystackLength: number,
  needle: number,
  needleLength: number,
): number;
export function json_token_starts(input: number, length: number, output: number): number;
