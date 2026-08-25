export const memory: WebAssembly.Memory;
export function init_controls(controls: number, capacity: number): void;
export function find(
  controls: number,
  offsets: number,
  lengths: number,
  capacity: number,
  arena: number,
  key: number,
  keyLength: number,
): number;
export function insert_map(
  controls: number,
  offsets: number,
  lengths: number,
  values: number,
  capacity: number,
  arena: number,
  key: number,
  keyLength: number,
  keyOffset: number,
  value: number,
): number;
export function insert_map_many(
  controls: number,
  keyOffsets: number,
  keyLengths: number,
  tableValues: number,
  capacity: number,
  arena: number,
  inputBaseOffset: number,
  inputOffsets: number,
  inputValues: number,
  count: number,
): number;
export function lookup_many(
  controls: number,
  keyOffsets: number,
  keyLengths: number,
  tableValues: number,
  capacity: number,
  arena: number,
  queries: number,
  queryOffsets: number,
  count: number,
  output: number,
  present: number,
): number;
export function remove(
  controls: number,
  offsets: number,
  lengths: number,
  capacity: number,
  arena: number,
  key: number,
  keyLength: number,
): number;
export function rehash_map(
  oldControls: number,
  oldOffsets: number,
  oldLengths: number,
  oldValues: number,
  oldCapacity: number,
  arena: number,
  newControls: number,
  newOffsets: number,
  newLengths: number,
  newValues: number,
  newCapacity: number,
): void;
