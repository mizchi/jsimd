export const memory: WebAssembly.Memory;
export function sum(pointer: number, length: number): bigint;
export function min(pointer: number, length: number): number;
export function max(pointer: number, length: number): number;
export function equal(left: number, right: number, paddedLength: number): number;
export function add(target: number, source: number, paddedLength: number): void;
