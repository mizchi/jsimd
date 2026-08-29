import { type F32GemmPlan, normalizeF32GemmPlan } from "./gemm_plan.ts";

export function packF32GemmRight(
  plan: F32GemmPlan,
  source: Float32Array,
): Float32Array {
  const normalized = normalizeF32GemmPlan(plan);
  const packed = new Float32Array(packedF32GemmRightLength(normalized));
  packNormalizedF32GemmRightInto(normalized, source, packed);
  return packed;
}

export function packF32GemmRightInto(
  plan: F32GemmPlan,
  source: Float32Array,
  target: Float32Array,
): void {
  const normalized = normalizeF32GemmPlan(plan);
  const packedLength = packedF32GemmRightLength(normalized);
  if (target.length !== packedLength) {
    throw new RangeError(`packed right matrix length must be ${packedLength}`);
  }
  const panelColumns = f32GemmPanelColumns(normalized.rowTile);
  if (normalized.columns % panelColumns !== 0) target.fill(0);
  packNormalizedF32GemmRightInto(normalized, source, target);
}

function packNormalizedF32GemmRightInto(
  normalized: ReturnType<typeof normalizeF32GemmPlan>,
  source: Float32Array,
  packed: Float32Array,
): void {
  const expected = normalized.inner * normalized.columns;
  if (source.length !== expected) {
    throw new RangeError(`right matrix length must be ${expected}`);
  }
  const panelColumns = f32GemmPanelColumns(normalized.rowTile);
  const panelCount = Math.ceil(normalized.columns / panelColumns);
  for (let panel = 0; panel < panelCount; panel++) {
    const firstColumn = panel * panelColumns;
    const panelBase = panel * normalized.inner * panelColumns;
    const copiedColumns = Math.min(panelColumns, normalized.columns - firstColumn);
    for (let inner = 0; inner < normalized.inner; inner++) {
      const sourceOffset = inner * normalized.columns + firstColumn;
      const packedOffset = panelBase + inner * panelColumns;
      packed.set(source.subarray(sourceOffset, sourceOffset + copiedColumns), packedOffset);
    }
  }
}

function packedF32GemmRightLength(
  plan: ReturnType<typeof normalizeF32GemmPlan>,
): number {
  const panelColumns = f32GemmPanelColumns(plan.rowTile);
  return Math.ceil(plan.columns / panelColumns) * plan.inner * panelColumns;
}

export function f32GemmPanelColumns(rowTile: 1 | 2 | 4 | 8): number {
  return 32 / rowTile;
}
