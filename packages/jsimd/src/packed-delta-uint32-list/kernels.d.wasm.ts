export const memory: WebAssembly.Memory;
export function init_shuffle_table(pointer: number): void;
export function at(
  data: number,
  controls: number,
  checkpoints: number,
  index: number,
): bigint;
export function lower_bound(
  data: number,
  controls: number,
  checkpoints: number,
  length: number,
  target: number,
): number;
export function decode_range(
  data: number,
  controls: number,
  checkpoints: number,
  length: number,
  start: number,
  output: number,
  outputLength: number,
): number;
export function intersect_into(
  leftData: number,
  leftControls: number,
  leftLength: number,
  rightData: number,
  rightControls: number,
  rightLength: number,
  output: number,
  outputLength: number,
): number;
