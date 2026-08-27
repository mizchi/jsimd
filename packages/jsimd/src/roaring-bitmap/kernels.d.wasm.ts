export const memory: WebAssembly.Memory;
export function bitmap_and_count(left: number, right: number): number;
export function bitmap_intersects(left: number, right: number): number;
export function bitmap_and_into(left: number, right: number, output: number): number;
export function bitmap_or_into(left: number, right: number, output: number): number;
export function bitmap_xor_into(left: number, right: number, output: number): number;
export function bitmap_and_not_into(left: number, right: number, output: number): number;
export function array_array_count(
  left: number,
  leftLength: number,
  right: number,
  rightLength: number,
): number;
export function array_array_intersects(
  left: number,
  leftLength: number,
  right: number,
  rightLength: number,
): number;
export function array_array_and_into(
  left: number,
  leftLength: number,
  right: number,
  rightLength: number,
  output: number,
): number;
export function array_bitmap_count(array: number, length: number, bitmap: number): number;
export function array_bitmap_intersects(array: number, length: number, bitmap: number): number;
export function array_bitmap_and_into(
  array: number,
  length: number,
  bitmap: number,
  output: number,
): number;
