export const memory: WebAssembly.Memory;
export function astar_simd(
  walls: number,
  width: number,
  height: number,
  start: number,
  target: number,
  distances: number,
  previous: number,
  heapPriorities: number,
  heapIds: number,
  outputId: number,
  outputPriority: number,
): number;
export function astar_scalar(
  walls: number,
  width: number,
  height: number,
  start: number,
  target: number,
  distances: number,
  previous: number,
  heapPriorities: number,
  heapIds: number,
  outputId: number,
  outputPriority: number,
): number;
