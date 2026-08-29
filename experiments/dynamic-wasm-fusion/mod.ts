import type { CompiledF32GemmWithFallback, F32GemmCompiler } from "./gemm.ts";
import { createF32GemmCompiler } from "./gemm.ts";
import type { F32GemmRuntimeFeatures } from "./gemm_features.ts";
import type { F32GemmPlan } from "./gemm_plan.ts";
import type { CompiledF32Map, F32MapCompiler } from "./map.ts";
import { createF32MapCompiler } from "./map.ts";
import type { F32Expression } from "./expression.ts";
import { cacheBound } from "./lru_promise_cache.ts";

export * from "./gemm.ts";
export * from "./map.ts";

export interface DynamicWasmFusionCompilerOptions {
  readonly maxMapModules?: number;
  readonly maxGemmModules?: number;
}

export interface DynamicWasmFusionCacheStats {
  readonly mapModules: number;
  readonly gemmModules: number;
  readonly maxMapModules: number;
  readonly maxGemmModules: number;
}

export interface DynamicWasmFusionCompiler {
  compileMap(expression: F32Expression, inputCount: number): Promise<CompiledF32Map>;
  compileGemm(plan: F32GemmPlan): ReturnType<F32GemmCompiler["compile"]>;
  compileGemmWithFallback(
    plan: F32GemmPlan,
    features?: F32GemmRuntimeFeatures,
  ): Promise<CompiledF32GemmWithFallback>;
  clearCache(): void;
  cacheStats(): DynamicWasmFusionCacheStats;
}

export function createDynamicWasmFusionCompiler(
  options: DynamicWasmFusionCompilerOptions = {},
): DynamicWasmFusionCompiler {
  const map: F32MapCompiler = createF32MapCompiler(
    cacheBound(options.maxMapModules, "maxMapModules"),
  );
  const gemm: F32GemmCompiler = createF32GemmCompiler(
    cacheBound(options.maxGemmModules, "maxGemmModules"),
  );
  return Object.freeze({
    compileMap: map.compile,
    compileGemm: gemm.compile,
    compileGemmWithFallback: gemm.compileWithFallback,
    clearCache(): void {
      map.clearCache();
      gemm.clearCache();
    },
    cacheStats(): DynamicWasmFusionCacheStats {
      const mapStats = map.cacheStats();
      const gemmStats = gemm.cacheStats();
      return Object.freeze({
        mapModules: mapStats.modules,
        gemmModules: gemmStats.modules,
        maxMapModules: mapStats.maximum,
        maxGemmModules: gemmStats.maximum,
      });
    },
  });
}
