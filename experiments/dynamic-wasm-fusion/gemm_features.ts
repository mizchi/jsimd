import { emitF32GemmModule } from "./gemm_emitter.ts";
import { type F32GemmPlan, normalizeF32GemmPlan } from "./gemm_plan.ts";

export interface F32GemmRuntimeFeatures {
  readonly relaxedSimd: boolean;
}

let detectedFeatures: F32GemmRuntimeFeatures | undefined;

export function detectF32GemmRuntimeFeatures(): F32GemmRuntimeFeatures {
  if (detectedFeatures !== undefined) return detectedFeatures;
  const relaxedProbe = emitF32GemmModule(normalizeF32GemmPlan({
    rows: 1,
    inner: 1,
    columns: 4,
    rowTile: 1,
    multiplyAdd: "relaxed",
  }));
  detectedFeatures = Object.freeze({
    relaxedSimd: WebAssembly.validate(relaxedProbe),
  });
  return detectedFeatures;
}

export function resolveF32GemmPlan(
  plan: F32GemmPlan,
  features: F32GemmRuntimeFeatures,
): F32GemmPlan {
  if (plan.multiplyAdd !== "relaxed" || features.relaxedSimd) return plan;
  return { ...plan, multiplyAdd: "strict" };
}
