export const memory: WebAssembly.Memory;
export function add_u32_many(
  state: number,
  precision: number,
  values: number,
  length: number,
): void;
export function merge_state(output: number, other: number, registerCount: number): void;
