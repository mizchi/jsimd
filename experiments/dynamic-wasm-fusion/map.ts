import { emitF32MapModule } from "./binary_emitter.ts";
import { expressionKey, type F32Expression, validateExpression } from "./expression.ts";
import { cacheBound, LruPromiseCache } from "./lru_promise_cache.ts";

export { absolute, add, constant, input, maximum, minimum, multiply, relu } from "./expression.ts";
export type { F32Expression } from "./expression.ts";

export interface F32MapKernelInstance {
  /** Input pointers, followed by the output pointer and element count. */
  readonly run: (...arguments_: number[]) => void;
}

export interface CompiledF32Map {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly module: WebAssembly.Module;
  instantiate(memory: WebAssembly.Memory): Promise<F32MapKernelInstance>;
}

export interface F32MapCompiler {
  compile(expression: F32Expression, inputCount: number): Promise<CompiledF32Map>;
  clearCache(): void;
  cacheStats(): Readonly<{ modules: number; maximum: number }>;
}

export function createF32MapCompiler(maximum = 64): F32MapCompiler {
  const normalizedMaximum = cacheBound(maximum, "maximum");
  const cache = new LruPromiseCache<CompiledF32Map>(normalizedMaximum);
  return Object.freeze({
    compile(expression: F32Expression, inputCount: number): Promise<CompiledF32Map> {
      validateExpression(expression, inputCount);
      const key = expressionKey(expression, inputCount);
      return cache.getOrCreate(key, () => compileUncached(expression, inputCount));
    },
    clearCache(): void {
      cache.clear();
    },
    cacheStats(): Readonly<{ modules: number; maximum: number }> {
      return Object.freeze({ modules: cache.size, maximum: normalizedMaximum });
    },
  });
}

const defaultCompiler = createF32MapCompiler();

export function compileF32Map(
  expression: F32Expression,
  inputCount: number,
): Promise<CompiledF32Map> {
  return defaultCompiler.compile(expression, inputCount);
}

async function compileUncached(
  expression: F32Expression,
  inputCount: number,
): Promise<CompiledF32Map> {
  const bytes = emitF32MapModule(expression, inputCount);
  if (!WebAssembly.validate(bytes)) throw new WebAssembly.CompileError("emitted module is invalid");
  const module = await WebAssembly.compile(bytes);
  return {
    bytes,
    module,
    async instantiate(memory: WebAssembly.Memory): Promise<F32MapKernelInstance> {
      const instance = await WebAssembly.instantiate(module, { env: { memory } });
      const run = instance.exports.run;
      if (typeof run !== "function") throw new TypeError("generated module does not export run");
      return { run: run as (...arguments_: number[]) => void };
    },
  };
}
