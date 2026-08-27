export const memory: WebAssembly.Memory;
export function push(
  priorities: number,
  ids: number,
  size: number,
  id: number,
  priority: number,
): number;
export function push_many(
  priorities: number,
  ids: number,
  size: number,
  inputIds: number,
  inputPriorities: number,
  count: number,
): number;
export function pop_simd(
  priorities: number,
  ids: number,
  size: number,
  outputId: number,
  outputPriority: number,
): number;
export function pop_scalar(
  priorities: number,
  ids: number,
  size: number,
  outputId: number,
  outputPriority: number,
): number;

export type DijkstraKernel = (
  offsets: number,
  targets: number,
  weights: number,
  nodeCount: number,
  start: number,
  target: number,
  distances: number,
  previous: number,
  heapPriorities: number,
  heapIds: number,
  outputId: number,
  outputPriority: number,
) => number;

export const dijkstra_simd: DijkstraKernel;
export const dijkstra_scalar: DijkstraKernel;
