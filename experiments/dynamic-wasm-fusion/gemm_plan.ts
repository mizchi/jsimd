export type F32GemmBias =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "scalar"; value: number }>
  | Readonly<{ kind: "columns" }>;

export type F32GemmActivation =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "relu" }>
  | Readonly<{ kind: "clamp"; minimum: number; maximum: number }>;

export type F32GemmRowTile = 1 | 2 | 4 | 8;
export type F32GemmMultiplyAdd = "strict" | "relaxed";
export type F32GemmInnerLoop = "loop" | "unroll2" | "unroll4" | "unrolled";
export type F32GemmRightLayout = "row-major" | "packed-panels";

export const MAX_FULLY_UNROLLED_INNER = 256;

export interface F32GemmPlan {
  readonly rows: number;
  readonly inner: number;
  readonly columns: number;
  readonly alpha?: number;
  readonly beta?: number;
  readonly bias?: F32GemmBias;
  readonly activation?: F32GemmActivation;
  /** Number of output rows sharing each eight-accumulator microtile. */
  readonly rowTile?: F32GemmRowTile;
  /** Relaxed SIMD may use hardware FMA and can change floating-point rounding. */
  readonly multiplyAdd?: F32GemmMultiplyAdd;
  /** Full unrolling trades module size and compilation cost for less loop overhead. */
  readonly innerLoop?: F32GemmInnerLoop;
  /** Packed panels trade one-time conversion and padding for a smaller K-loop stride. */
  readonly rightLayout?: F32GemmRightLayout;
  /** Packed-B column block width. Must be a multiple of the plan's NR panel width. */
  readonly columnBlock?: number;
}

export interface NormalizedF32GemmPlan {
  readonly rows: number;
  readonly inner: number;
  readonly columns: number;
  readonly alpha: number;
  readonly beta: number;
  readonly bias: F32GemmBias;
  readonly activation: F32GemmActivation;
  readonly rowTile: F32GemmRowTile;
  readonly multiplyAdd: F32GemmMultiplyAdd;
  readonly innerLoop: F32GemmInnerLoop;
  readonly rightLayout: F32GemmRightLayout;
  readonly columnBlock: number | undefined;
}

const MAX_ELEMENTS = 0x3fff_ffff;

export function normalizeF32GemmPlan(plan: F32GemmPlan): NormalizedF32GemmPlan {
  const rows = dimension(plan.rows, "rows");
  const inner = dimension(plan.inner, "inner");
  const columns = dimension(plan.columns, "columns");
  boundedProduct(rows, inner, "left matrix");
  boundedProduct(inner, columns, "right matrix");
  boundedProduct(rows, columns, "output matrix");
  const alpha = finite(plan.alpha ?? 1, "alpha");
  const beta = finite(plan.beta ?? 0, "beta");
  const bias = normalizeBias(plan.bias);
  const activation = normalizeActivation(plan.activation);
  const rowTile = normalizeRowTile(plan.rowTile);
  const multiplyAdd = normalizeMultiplyAdd(plan.multiplyAdd);
  const innerLoop = normalizeInnerLoop(plan.innerLoop);
  if (innerLoop === "unrolled" && inner > MAX_FULLY_UNROLLED_INNER) {
    throw new RangeError(
      `fully unrolled inner dimension must not exceed ${MAX_FULLY_UNROLLED_INNER}`,
    );
  }
  const rightLayout = normalizeRightLayout(plan.rightLayout);
  const columnBlock = normalizeColumnBlock(plan.columnBlock, rowTile, rightLayout);
  return Object.freeze({
    rows,
    inner,
    columns,
    alpha,
    beta,
    bias,
    activation,
    rowTile,
    multiplyAdd,
    innerLoop,
    rightLayout,
    columnBlock,
  });
}

export function f32GemmPlanKey(plan: NormalizedF32GemmPlan): string {
  return [
    plan.rows,
    plan.inner,
    plan.columns,
    f32Key(plan.alpha),
    f32Key(plan.beta),
    biasKey(plan.bias),
    activationKey(plan.activation),
    `mr${plan.rowTile}`,
    plan.multiplyAdd,
    plan.innerLoop,
    plan.rightLayout,
    plan.columnBlock === undefined ? "nc-none" : `nc${plan.columnBlock}`,
  ].join(":");
}

function normalizeColumnBlock(
  columnBlock: number | undefined,
  rowTile: F32GemmRowTile,
  rightLayout: F32GemmRightLayout,
): number | undefined {
  if (columnBlock === undefined) return undefined;
  if (!Number.isSafeInteger(columnBlock) || columnBlock <= 0) {
    throw new RangeError("columnBlock must be a positive integer");
  }
  if (rightLayout !== "packed-panels") {
    throw new RangeError("columnBlock requires packed-panels right layout");
  }
  const panelColumns = 32 / rowTile;
  if (columnBlock % panelColumns !== 0) {
    throw new RangeError(`columnBlock must be a multiple of ${panelColumns}`);
  }
  return columnBlock;
}

function normalizeRightLayout(
  rightLayout: F32GemmRightLayout | undefined,
): F32GemmRightLayout {
  if (rightLayout === undefined || rightLayout === "row-major") return "row-major";
  if (rightLayout === "packed-panels") return "packed-panels";
  throw new RangeError("rightLayout must be row-major or packed-panels");
}

function normalizeInnerLoop(innerLoop: F32GemmInnerLoop | undefined): F32GemmInnerLoop {
  if (innerLoop === undefined || innerLoop === "loop") return "loop";
  if (innerLoop === "unroll2" || innerLoop === "unroll4" || innerLoop === "unrolled") {
    return innerLoop;
  }
  throw new RangeError("innerLoop must be loop, unroll2, unroll4, or unrolled");
}

function normalizeMultiplyAdd(
  multiplyAdd: F32GemmMultiplyAdd | undefined,
): F32GemmMultiplyAdd {
  if (multiplyAdd === undefined || multiplyAdd === "strict") return "strict";
  if (multiplyAdd === "relaxed") return "relaxed";
  throw new RangeError("multiplyAdd must be strict or relaxed");
}

function normalizeRowTile(rowTile: F32GemmRowTile | undefined): F32GemmRowTile {
  if (rowTile === undefined) return 1;
  if (rowTile === 1 || rowTile === 2 || rowTile === 4 || rowTile === 8) return rowTile;
  throw new RangeError("rowTile must be 1, 2, 4, or 8");
}

function normalizeBias(bias: F32GemmBias | undefined): F32GemmBias {
  if (bias === undefined || bias.kind === "none") return Object.freeze({ kind: "none" });
  if (bias.kind === "columns") return Object.freeze({ kind: "columns" });
  if (bias.kind === "scalar") {
    return Object.freeze({ kind: "scalar", value: finite(bias.value, "bias") });
  }
  throw new TypeError("unsupported bias kind");
}

function normalizeActivation(activation: F32GemmActivation | undefined): F32GemmActivation {
  if (activation === undefined || activation.kind === "none") {
    return Object.freeze({ kind: "none" });
  }
  if (activation.kind === "relu") return Object.freeze({ kind: "relu" });
  if (activation.kind === "clamp") {
    const minimum = finite(activation.minimum, "clamp minimum");
    const maximum = finite(activation.maximum, "clamp maximum");
    if (minimum > maximum) throw new RangeError("clamp minimum must not exceed maximum");
    return Object.freeze({ kind: "clamp", minimum, maximum });
  }
  throw new TypeError("unsupported activation kind");
}

function dimension(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_ELEMENTS) {
    throw new RangeError(`${name} must be a non-negative addressable integer`);
  }
  return value;
}

function boundedProduct(left: number, right: number, name: string): void {
  if (left * right > MAX_ELEMENTS) throw new RangeError(`${name} exceeds Wasm32 memory indexing`);
}

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
  return Math.fround(value);
}

function f32Key(value: number): string {
  const bytes = new ArrayBuffer(4);
  const view = new DataView(bytes);
  view.setFloat32(0, value, true);
  return view.getUint32(0, true).toString(16).padStart(8, "0");
}

function biasKey(bias: F32GemmBias): string {
  return bias.kind === "scalar" ? `scalar-${f32Key(bias.value)}` : bias.kind;
}

function activationKey(activation: F32GemmActivation): string {
  return activation.kind === "clamp"
    ? `clamp-${f32Key(activation.minimum)}-${f32Key(activation.maximum)}`
    : activation.kind;
}
