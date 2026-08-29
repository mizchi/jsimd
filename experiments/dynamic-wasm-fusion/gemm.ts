import { emitF32GemmModule } from "./gemm_emitter.ts";
import {
  detectF32GemmRuntimeFeatures,
  type F32GemmRuntimeFeatures,
  resolveF32GemmPlan,
} from "./gemm_features.ts";
import {
  type F32GemmMultiplyAdd,
  type F32GemmPlan,
  f32GemmPlanKey,
  normalizeF32GemmPlan,
} from "./gemm_plan.ts";
import { cacheBound, LruPromiseCache } from "./lru_promise_cache.ts";

export { packF32GemmRight, packF32GemmRightInto } from "./gemm_packing.ts";
export { detectF32GemmRuntimeFeatures, resolveF32GemmPlan } from "./gemm_features.ts";
export type { F32GemmRuntimeFeatures } from "./gemm_features.ts";
export { MAX_FULLY_UNROLLED_INNER } from "./gemm_plan.ts";
export type {
  F32GemmActivation,
  F32GemmBias,
  F32GemmInnerLoop,
  F32GemmMultiplyAdd,
  F32GemmPlan,
  F32GemmRightLayout,
  F32GemmRowTile,
} from "./gemm_plan.ts";

export interface F32GemmKernelInstance {
  /** Row-major A, plan-layout B, row-major in/out C, and optional column-bias pointers. */
  readonly run: (
    aPointer: number,
    bPointer: number,
    cPointer: number,
    biasPointer: number,
  ) => void;
}

export interface CompiledF32Gemm {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly module: WebAssembly.Module;
  instantiate(memory: WebAssembly.Memory): Promise<F32GemmKernelInstance>;
}

export interface CompiledF32GemmWithFallback {
  readonly compiled: CompiledF32Gemm;
  readonly effectiveMultiplyAdd: F32GemmMultiplyAdd;
}

export interface F32GemmCompiler {
  compile(plan: F32GemmPlan): Promise<CompiledF32Gemm>;
  compileWithFallback(
    plan: F32GemmPlan,
    features?: F32GemmRuntimeFeatures,
  ): Promise<CompiledF32GemmWithFallback>;
  clearCache(): void;
  cacheStats(): Readonly<{ modules: number; maximum: number }>;
}

export function createF32GemmCompiler(maximum = 64): F32GemmCompiler {
  const normalizedMaximum = cacheBound(maximum, "maximum");
  const cache = new LruPromiseCache<CompiledF32Gemm>(normalizedMaximum);
  const compile = (plan: F32GemmPlan): Promise<CompiledF32Gemm> => {
    const normalized = normalizeF32GemmPlan(plan);
    const key = f32GemmPlanKey(normalized);
    return cache.getOrCreate(key, () => compileUncached(normalized));
  };
  return Object.freeze({
    compile,
    async compileWithFallback(
      plan: F32GemmPlan,
      features: F32GemmRuntimeFeatures = detectF32GemmRuntimeFeatures(),
    ): Promise<CompiledF32GemmWithFallback> {
      const resolved = resolveF32GemmPlan(plan, features);
      return {
        compiled: await compile(resolved),
        effectiveMultiplyAdd: resolved.multiplyAdd ?? "strict",
      };
    },
    clearCache(): void {
      cache.clear();
    },
    cacheStats(): Readonly<{ modules: number; maximum: number }> {
      return Object.freeze({ modules: cache.size, maximum: normalizedMaximum });
    },
  });
}

const defaultCompiler = createF32GemmCompiler();

export function compileF32Gemm(plan: F32GemmPlan): Promise<CompiledF32Gemm> {
  return defaultCompiler.compile(plan);
}

export function compileF32GemmWithFallback(
  plan: F32GemmPlan,
  features?: F32GemmRuntimeFeatures,
): Promise<CompiledF32GemmWithFallback> {
  return defaultCompiler.compileWithFallback(plan, features);
}

async function compileUncached(
  plan: ReturnType<typeof normalizeF32GemmPlan>,
): Promise<CompiledF32Gemm> {
  const bytes = emitF32GemmModule(plan);
  if (!WebAssembly.validate(bytes)) {
    throw new WebAssembly.CompileError("emitted GEMM module is invalid");
  }
  const module = await WebAssembly.compile(bytes);
  return {
    bytes,
    module,
    async instantiate(memory: WebAssembly.Memory): Promise<F32GemmKernelInstance> {
      const instance = await WebAssembly.instantiate(module, { env: { memory } });
      const run = instance.exports.run;
      if (typeof run !== "function") {
        throw new TypeError("generated GEMM module does not export run");
      }
      return {
        run: run as (
          aPointer: number,
          bPointer: number,
          cPointer: number,
          biasPointer: number,
        ) => void,
      };
    },
  };
}
