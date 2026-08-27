export declare const memory: WebAssembly.Memory;

export declare function scan_i32_eq_raw(
  input: number,
  output: number,
  length: number,
  value: number,
): void;
export declare function scan_i32_eq_for(
  packed: number,
  output: number,
  length: number,
  width: number,
  base: number,
  value: number,
): void;
export declare function scan_i32_lt_raw(
  input: number,
  output: number,
  length: number,
  value: number,
): void;
export declare function scan_i32_lt_for(
  packed: number,
  output: number,
  length: number,
  width: number,
  base: number,
  value: number,
): void;
export declare function scan_i32_between_raw(
  input: number,
  output: number,
  length: number,
  minimum: number,
  maximum: number,
): void;
export declare function scan_i32_between_for(
  packed: number,
  output: number,
  length: number,
  width: number,
  base: number,
  minimum: number,
  maximum: number,
): void;

export declare function scan_u32_eq_raw(
  input: number,
  output: number,
  length: number,
  value: number,
): void;
export declare function scan_u32_eq_for(
  packed: number,
  output: number,
  length: number,
  width: number,
  base: number,
  value: number,
): void;
export declare function scan_u32_lt_raw(
  input: number,
  output: number,
  length: number,
  value: number,
): void;
export declare function scan_u32_lt_for(
  packed: number,
  output: number,
  length: number,
  width: number,
  base: number,
  value: number,
): void;
export declare function scan_u32_between_raw(
  input: number,
  output: number,
  length: number,
  minimum: number,
  maximum: number,
): void;
export declare function scan_u32_between_for(
  packed: number,
  output: number,
  length: number,
  width: number,
  base: number,
  minimum: number,
  maximum: number,
): void;
export declare function scan_u8_eq(
  planes: number,
  validity: number,
  output: number,
  wordCount: number,
  bitWidth: number,
  value: number,
): void;
export declare function scan_u8_lt(
  planes: number,
  validity: number,
  output: number,
  wordCount: number,
  bitWidth: number,
  value: number,
): void;
export declare function scan_u8_between(
  planes: number,
  validity: number,
  output: number,
  wordCount: number,
  bitWidth: number,
  minimum: number,
  maximumExclusive: number,
): void;

export declare function gather_i32_constant(
  mask: number,
  length: number,
  value: number,
  output: number,
): number;
export declare function gather_i32_raw(
  input: number,
  mask: number,
  length: number,
  output: number,
): number;
export declare function gather_i32_for(
  packed: number,
  mask: number,
  length: number,
  width: number,
  base: number,
  output: number,
): number;
export declare function gather_u8(
  planes: number,
  validity: number,
  mask: number,
  wordCount: number,
  bitWidth: number,
  output: number,
  outputValidity: number,
): number;

export declare function mask_and(left: number, right: number, wordCount: number): void;
export declare function mask_or(left: number, right: number, wordCount: number): void;
export declare function mask_andnot(left: number, right: number, wordCount: number): void;
export declare function mask_not(pointer: number, wordCount: number): void;
export declare function mask_count(pointer: number, wordCount: number): number;
export declare function mask_positions_into(
  pointer: number,
  wordCount: number,
  output: number,
): number;
