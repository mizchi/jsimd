import { LruPromiseCache } from "./cache.ts";
import { emitF32FusionModule } from "./emitter.ts";
import { expressionKey, type F32Expression, input, validateExpression } from "./expression.ts";

export { absolute, add, constant, input, maximum, minimum, multiply, relu } from "./expression.ts";
export type { F32Expression } from "./expression.ts";

export interface F32FusionCompilerOptions {
  readonly maxModules?: number;
}

export interface F32FusionCompilerStats {
  readonly modules: number;
  readonly maximum: number;
}

export interface F32FusionKernel {
  readonly inputCount: number;
  run(inputPointers: readonly number[], outputPointer: number, length: number): void;
}

export interface CompiledF32Fusion {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly module: WebAssembly.Module;
  readonly inputCount: number;
  instantiate(memory: WebAssembly.Memory): Promise<F32FusionKernel>;
}

export interface F32FusionCompiler extends Disposable {
  compile(expression: F32Expression, inputCount: number): Promise<CompiledF32Fusion>;
  clearCache(): void;
  cacheStats(): F32FusionCompilerStats;
}

export function createF32FusionCompiler(
  options: F32FusionCompilerOptions = {},
): F32FusionCompiler {
  const maximum = positiveInteger(options.maxModules ?? 64, "maxModules");
  const cache = new LruPromiseCache<CompiledF32Fusion>(maximum);
  let disposed = false;
  const assertAlive = (): void => {
    if (disposed) throw new Error("F32FusionCompiler has been disposed");
  };
  return Object.freeze({
    compile(expression: F32Expression, inputCount: number): Promise<CompiledF32Fusion> {
      assertAlive();
      validateExpression(expression, inputCount);
      const key = expressionKey(expression, inputCount);
      return cache.getOrCreate(key, () => compileUncached(expression, inputCount));
    },
    clearCache(): void {
      assertAlive();
      cache.clear();
    },
    cacheStats(): F32FusionCompilerStats {
      return Object.freeze({ modules: cache.size, maximum });
    },
    [Symbol.dispose](): void {
      if (disposed) return;
      cache.clear();
      disposed = true;
    },
  });
}

let supportProbe: Promise<boolean> | undefined;

export function supportsF32Fusion(): Promise<boolean> {
  supportProbe ??= (async () => {
    try {
      const bytes = emitF32FusionModule(input(0), 1);
      if (!WebAssembly.validate(bytes)) return false;
      await WebAssembly.compile(bytes);
      return true;
    } catch {
      return false;
    }
  })();
  return supportProbe;
}

async function compileUncached(
  expression: F32Expression,
  inputCount: number,
): Promise<CompiledF32Fusion> {
  const bytes = emitF32FusionModule(expression, inputCount);
  if (!WebAssembly.validate(bytes)) {
    throw new WebAssembly.CompileError("generated f32 fusion module is invalid");
  }
  const module = await WebAssembly.compile(bytes);
  return Object.freeze({
    bytes,
    module,
    inputCount,
    async instantiate(memory: WebAssembly.Memory): Promise<F32FusionKernel> {
      const instance = await WebAssembly.instantiate(module, { env: { memory } });
      const exported = instance.exports.run;
      if (typeof exported !== "function") {
        throw new TypeError("generated f32 fusion module does not export run");
      }
      const rawRun = exported as (...arguments_: number[]) => void;
      return Object.freeze({
        inputCount,
        run(inputPointers: readonly number[], outputPointer: number, length: number): void {
          if (inputPointers.length !== inputCount) {
            throw new RangeError(`expected ${inputCount} input pointers`);
          }
          const normalizedLength = nonNegativeInteger(length, "length");
          const normalizedOutput = pointer(outputPointer);
          const normalizedInputs = inputPointers.map(pointer);
          const byteLength = normalizedLength * 4;
          checkRange(memory, normalizedOutput, byteLength);
          for (const inputPointer of normalizedInputs) checkRange(memory, inputPointer, byteLength);
          rawRun(...normalizedInputs, normalizedOutput, normalizedLength);
        },
      });
    },
  });
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x3fff_ffff) {
    throw new RangeError(`${name} must be a non-negative addressable integer`);
  }
  return value;
}

function pointer(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError("pointer must be a non-negative Wasm32 address");
  }
  return value;
}

function checkRange(memory: WebAssembly.Memory, pointer: number, byteLength: number): void {
  if (pointer + byteLength > memory.buffer.byteLength) {
    throw new RangeError("f32 fusion range exceeds the imported memory");
  }
}
