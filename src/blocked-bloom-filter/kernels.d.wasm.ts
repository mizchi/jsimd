export declare const memory: WebAssembly.Memory;
export declare function add_many(
  blocks: number,
  blockCount: number,
  keys: number,
  length: number,
): void;
export declare function may_contain_many(
  blocks: number,
  blockCount: number,
  keys: number,
  output: number,
  length: number,
): number;
export declare function merge(blocks: number, other: number, blockCount: number): void;
