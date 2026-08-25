export const memory: WebAssembly.Memory;
export function init_controls(controls: number, capacity: number): void;
export function find(controls: number, keys: number, capacity: number, key: number): number;
export function insert_set(
  controls: number,
  keys: number,
  capacity: number,
  key: number,
): number;
export function insert_map(
  controls: number,
  keys: number,
  values: number,
  capacity: number,
  key: number,
  value: number,
): number;
export function remove(controls: number, keys: number, capacity: number, key: number): number;
export function lookup_many(
  controls: number,
  keys: number,
  capacity: number,
  queries: number,
  length: number,
  present: number,
): number;
export function map_lookup_many(
  controls: number,
  keys: number,
  tableValues: number,
  capacity: number,
  queries: number,
  length: number,
  outputValues: number,
  present: number,
): number;
export function insert_set_many(
  controls: number,
  keys: number,
  capacity: number,
  input: number,
  length: number,
): number;
export function insert_map_many(
  controls: number,
  keys: number,
  tableValues: number,
  capacity: number,
  inputKeys: number,
  inputValues: number,
  length: number,
): number;
export function rehash_set(
  oldControls: number,
  oldKeys: number,
  oldCapacity: number,
  newControls: number,
  newKeys: number,
  newCapacity: number,
): void;
export function rehash_map(
  oldControls: number,
  oldKeys: number,
  oldValues: number,
  oldCapacity: number,
  newControls: number,
  newKeys: number,
  newValues: number,
  newCapacity: number,
): void;
