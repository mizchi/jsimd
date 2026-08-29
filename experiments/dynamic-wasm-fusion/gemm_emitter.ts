import type { NormalizedF32GemmPlan } from "./gemm_plan.ts";
import {
  ByteWriter,
  emitImportedMemoryModule,
  EMPTY_BLOCK,
  F32,
  I32,
  V128,
} from "./wasm_binary.ts";

const opcode = {
  block: 0x02,
  loop: 0x03,
  end: 0x0b,
  branch: 0x0c,
  branchIf: 0x0d,
  localGet: 0x20,
  localSet: 0x21,
  f32Load: 0x2a,
  f32Store: 0x38,
  i32Constant: 0x41,
  f32Constant: 0x43,
  i32GreaterEqualUnsigned: 0x4f,
  i32Add: 0x6a,
  i32Multiply: 0x6c,
  i32And: 0x71,
  i32ShiftLeft: 0x74,
  i32ShiftRightUnsigned: 0x76,
  f32Add: 0x92,
  f32Multiply: 0x94,
  f32Minimum: 0x96,
  f32Maximum: 0x97,
} as const;

const simdOpcode = {
  v128Load: 0x00,
  v128Store: 0x0b,
  f32x4Splat: 0x13,
  f32x4Add: 0xe4,
  f32x4Multiply: 0xe6,
  f32x4Minimum: 0xe8,
  f32x4Maximum: 0xe9,
  f32x4RelaxedMultiplyAdd: 0x105,
} as const;

const A_POINTER = 0;
const B_POINTER = 1;
const C_POINTER = 2;
const BIAS_POINTER = 3;
const ROW_LOCAL = 4;
const COLUMN_LOCAL = 5;
const INNER_LOCAL = 6;
const A_INNER_POINTER_LOCAL_BASE = 7;
const A_INNER_POINTER_LOCALS = 8;
const B_INNER_POINTER_LOCAL = A_INNER_POINTER_LOCAL_BASE + A_INNER_POINTER_LOCALS;
const COLUMN_BLOCK_START_LOCAL = B_INNER_POINTER_LOCAL + 1;
const COLUMN_BLOCK_END_LOCAL = COLUMN_BLOCK_START_LOCAL + 1;
const VECTOR_ACCUMULATOR_BASE = COLUMN_BLOCK_END_LOCAL + 1;
const VECTOR_TILE = 8;
const A_VECTOR_LOCAL = VECTOR_ACCUMULATOR_BASE + VECTOR_TILE;
const B_VECTOR_LOCAL_BASE = A_VECTOR_LOCAL + 1;
const B_VECTOR_LOCALS = 4;
const SCALAR_ACCUMULATOR_LOCAL = B_VECTOR_LOCAL_BASE + B_VECTOR_LOCALS;

export function emitF32GemmModule(plan: NormalizedF32GemmPlan): Uint8Array<ArrayBuffer> {
  const body = new ByteWriter();
  body.vector([
    [3 + A_INNER_POINTER_LOCALS + 3, I32],
    [VECTOR_TILE + 1 + B_VECTOR_LOCALS, V128],
    [1, F32],
  ]);
  const tiledRowLimit = plan.rows - plan.rows % plan.rowTile;
  const vectorCount = VECTOR_TILE / plan.rowTile;
  if (plan.columnBlock === undefined) {
    emitRows(body, plan, vectorCount, tiledRowLimit, 0);
  } else {
    emitBlockedRows(body, plan, vectorCount, tiledRowLimit);
  }
  body.instruction(opcode.end);

  return emitImportedMemoryModule([I32, I32, I32, I32], body);
}

function emitRows(
  body: ByteWriter,
  plan: NormalizedF32GemmPlan,
  vectorCount: number,
  tiledRowLimit: number,
  columnStart: number,
): void {
  setI32(body, ROW_LOCAL, 0);
  emitRowLoop(body, plan, plan.rowTile, vectorCount, tiledRowLimit, columnStart);
  if (plan.rowTile !== 1) {
    emitRowLoop(body, plan, 1, vectorCount, plan.rows, columnStart);
  }
}

function emitBlockedRows(
  body: ByteWriter,
  plan: NormalizedF32GemmPlan,
  vectorCount: number,
  tiledRowLimit: number,
): void {
  const columnTile = vectorCount * 4;
  const vectorColumnLimit = plan.columns - plan.columns % columnTile;
  const blockedColumnLimit = vectorColumnLimit - vectorColumnLimit % plan.columnBlock!;
  setI32(body, COLUMN_BLOCK_START_LOCAL, 0);
  beginLoop(body);
  branchIfAtLeastConstant(body, COLUMN_BLOCK_START_LOCAL, blockedColumnLimit, 1);
  body.instruction(opcode.localGet).unsigned(COLUMN_BLOCK_START_LOCAL);
  body.instruction(opcode.i32Constant).signed(plan.columnBlock!);
  body.instruction(opcode.i32Add);
  body.instruction(opcode.localSet).unsigned(COLUMN_BLOCK_END_LOCAL);
  setI32(body, ROW_LOCAL, 0);
  emitBlockedRowLoop(body, plan, plan.rowTile, vectorCount, tiledRowLimit);
  if (plan.rowTile !== 1) {
    emitBlockedRowLoop(body, plan, 1, vectorCount, plan.rows);
  }
  increment(body, COLUMN_BLOCK_START_LOCAL, plan.columnBlock!);
  body.instruction(opcode.branch).unsigned(0);
  endLoop(body);

  if (blockedColumnLimit < plan.columns) {
    emitRows(body, plan, vectorCount, tiledRowLimit, blockedColumnLimit);
  }
}

function emitBlockedRowLoop(
  body: ByteWriter,
  plan: NormalizedF32GemmPlan,
  rowTile: number,
  vectorCount: number,
  rowLimit: number,
): void {
  beginLoop(body);
  branchIfAtLeastConstant(body, ROW_LOCAL, rowLimit, 1);
  copyI32(body, COLUMN_LOCAL, COLUMN_BLOCK_START_LOCAL);
  emitVectorColumnLoop(body, plan, rowTile, vectorCount, {
    local: COLUMN_BLOCK_END_LOCAL,
  });
  increment(body, ROW_LOCAL, rowTile);
  body.instruction(opcode.branch).unsigned(0);
  endLoop(body);
}

function emitRowLoop(
  body: ByteWriter,
  plan: NormalizedF32GemmPlan,
  rowTile: number,
  vectorCount: number,
  rowLimit: number,
  columnStart: number,
): void {
  beginLoop(body);
  branchIfAtLeastConstant(body, ROW_LOCAL, rowLimit, 1);
  setI32(body, COLUMN_LOCAL, columnStart);

  const columnTile = vectorCount * 4;
  emitVectorColumnLoop(
    body,
    plan,
    rowTile,
    vectorCount,
    plan.columns - plan.columns % columnTile,
  );
  if (vectorCount !== 1) {
    emitVectorColumnLoop(body, plan, rowTile, 1, plan.columns & ~3);
  }
  for (let rowOffset = 0; rowOffset < rowTile; rowOffset++) {
    setI32(body, COLUMN_LOCAL, plan.columns & ~3);
    emitScalarColumnLoop(body, plan, rowOffset);
  }

  increment(body, ROW_LOCAL, rowTile);
  body.instruction(opcode.branch).unsigned(0);
  endLoop(body);
}

function emitVectorColumnLoop(
  body: ByteWriter,
  plan: NormalizedF32GemmPlan,
  rowTile: number,
  vectorCount: number,
  columnLimit: number | Readonly<{ local: number }>,
): void {
  beginLoop(body);
  branchIfAtLeast(body, COLUMN_LOCAL, columnLimit, 1);
  for (let rowOffset = 0; rowOffset < rowTile; rowOffset++) {
    for (let vector = 0; vector < vectorCount; vector++) {
      emitZeroVector(body);
      body.instruction(opcode.localSet).unsigned(
        accumulatorLocal(rowOffset, vector, vectorCount),
      );
    }
  }
  initializeVectorInnerPointers(body, plan, rowTile);
  if (plan.innerLoop === "unrolled") {
    for (let inner = 0; inner < plan.inner; inner++) {
      emitVectorInnerStep(body, plan, rowTile, vectorCount, inner);
    }
  } else {
    const factor = innerUnrollFactor(plan);
    const loopLimit = plan.inner - plan.inner % factor;
    setI32(body, INNER_LOCAL, 0);
    beginLoop(body);
    branchIfAtLeastConstant(body, INNER_LOCAL, loopLimit, 1);
    for (let offset = 0; offset < factor; offset++) {
      emitVectorInnerStep(body, plan, rowTile, vectorCount, offset);
    }
    incrementInnerPointers(body, rowTile, factor, rightInnerStride(plan));
    increment(body, INNER_LOCAL, factor);
    body.instruction(opcode.branch).unsigned(0);
    endLoop(body);
    for (let offset = 0; offset < plan.inner - loopLimit; offset++) {
      emitVectorInnerStep(body, plan, rowTile, vectorCount, offset);
    }
  }

  for (let rowOffset = 0; rowOffset < rowTile; rowOffset++) {
    for (let vector = 0; vector < vectorCount; vector++) {
      emitMatrixAddress(
        body,
        C_POINTER,
        ROW_LOCAL,
        plan.columns,
        COLUMN_LOCAL,
        vector * 4,
        rowOffset,
      );
      body.instruction(opcode.localGet).unsigned(
        accumulatorLocal(rowOffset, vector, vectorCount),
      );
      emitVectorEpilogue(body, plan, vector * 4, rowOffset);
      body.simd(simdOpcode.v128Store).memoryArgument(4);
    }
  }
  increment(body, COLUMN_LOCAL, vectorCount * 4);
  body.instruction(opcode.branch).unsigned(0);
  endLoop(body);
}

function emitVectorInnerStep(
  body: ByteWriter,
  plan: NormalizedF32GemmPlan,
  rowTile: number,
  vectorCount: number,
  innerOffset = 0,
): void {
  if (rowTile > 1) {
    for (let vector = 0; vector < vectorCount; vector++) {
      body.instruction(opcode.localGet).unsigned(B_INNER_POINTER_LOCAL);
      body.simd(simdOpcode.v128Load).memoryArgument(
        4,
        innerOffset * rightInnerStride(plan) * 4 + vector * 16,
      );
      body.instruction(opcode.localSet).unsigned(B_VECTOR_LOCAL_BASE + vector);
    }
  }
  for (let rowOffset = 0; rowOffset < rowTile; rowOffset++) {
    emitA(body, true, rowOffset, innerOffset);
    body.instruction(opcode.localSet).unsigned(A_VECTOR_LOCAL);
    for (let vector = 0; vector < vectorCount; vector++) {
      const accumulator = accumulatorLocal(rowOffset, vector, vectorCount);
      if (plan.multiplyAdd === "relaxed") {
        body.instruction(opcode.localGet).unsigned(A_VECTOR_LOCAL);
        emitBVector(body, plan, rowTile, vector, innerOffset);
        body.instruction(opcode.localGet).unsigned(accumulator);
        body.simd(simdOpcode.f32x4RelaxedMultiplyAdd);
      } else {
        body.instruction(opcode.localGet).unsigned(accumulator);
        body.instruction(opcode.localGet).unsigned(A_VECTOR_LOCAL);
        emitBVector(body, plan, rowTile, vector, innerOffset);
        body.simd(simdOpcode.f32x4Multiply);
        body.simd(simdOpcode.f32x4Add);
      }
      body.instruction(opcode.localSet).unsigned(accumulator);
    }
  }
}

function emitBVector(
  body: ByteWriter,
  plan: NormalizedF32GemmPlan,
  rowTile: number,
  vector: number,
  innerOffset = 0,
): void {
  if (rowTile === 1) {
    body.instruction(opcode.localGet).unsigned(B_INNER_POINTER_LOCAL);
    body.simd(simdOpcode.v128Load).memoryArgument(
      4,
      innerOffset * rightInnerStride(plan) * 4 + vector * 16,
    );
  } else {
    body.instruction(opcode.localGet).unsigned(B_VECTOR_LOCAL_BASE + vector);
  }
}

function emitScalarColumnLoop(
  body: ByteWriter,
  plan: NormalizedF32GemmPlan,
  rowOffset: number,
): void {
  beginLoop(body);
  branchIfAtLeastConstant(body, COLUMN_LOCAL, plan.columns, 1);
  body.instruction(opcode.f32Constant).float32(0);
  body.instruction(opcode.localSet).unsigned(SCALAR_ACCUMULATOR_LOCAL);
  initializeScalarInnerPointers(body, plan, rowOffset);
  if (plan.innerLoop === "unrolled") {
    for (let inner = 0; inner < plan.inner; inner++) {
      emitScalarInnerStep(body, plan, rowOffset, inner);
    }
  } else {
    const factor = innerUnrollFactor(plan);
    const loopLimit = plan.inner - plan.inner % factor;
    setI32(body, INNER_LOCAL, 0);
    beginLoop(body);
    branchIfAtLeastConstant(body, INNER_LOCAL, loopLimit, 1);
    for (let offset = 0; offset < factor; offset++) {
      emitScalarInnerStep(body, plan, rowOffset, offset);
    }
    incrementInnerPointers(body, 1, factor, rightInnerStride(plan), rowOffset);
    increment(body, INNER_LOCAL, factor);
    body.instruction(opcode.branch).unsigned(0);
    endLoop(body);
    for (let offset = 0; offset < plan.inner - loopLimit; offset++) {
      emitScalarInnerStep(body, plan, rowOffset, offset);
    }
  }

  emitMatrixAddress(body, C_POINTER, ROW_LOCAL, plan.columns, COLUMN_LOCAL, 0, rowOffset);
  body.instruction(opcode.localGet).unsigned(SCALAR_ACCUMULATOR_LOCAL);
  emitScalarEpilogue(body, plan, rowOffset);
  body.instruction(opcode.f32Store).memoryArgument(2);
  increment(body, COLUMN_LOCAL, 1);
  body.instruction(opcode.branch).unsigned(0);
  endLoop(body);
}

function emitScalarInnerStep(
  body: ByteWriter,
  plan: NormalizedF32GemmPlan,
  rowOffset: number,
  innerOffset = 0,
): void {
  body.instruction(opcode.localGet).unsigned(SCALAR_ACCUMULATOR_LOCAL);
  emitA(body, false, rowOffset, innerOffset);
  body.instruction(opcode.localGet).unsigned(B_INNER_POINTER_LOCAL);
  body.instruction(opcode.f32Load).memoryArgument(2, innerOffset * rightInnerStride(plan) * 4);
  body.instruction(opcode.f32Multiply);
  body.instruction(opcode.f32Add);
  body.instruction(opcode.localSet).unsigned(SCALAR_ACCUMULATOR_LOCAL);
}

function emitZeroVector(body: ByteWriter): void {
  body.instruction(opcode.f32Constant).float32(0);
  body.simd(simdOpcode.f32x4Splat);
}

function emitA(
  body: ByteWriter,
  splat: boolean,
  rowOffset: number,
  innerOffset = 0,
): void {
  body.instruction(opcode.localGet).unsigned(A_INNER_POINTER_LOCAL_BASE + rowOffset);
  body.instruction(opcode.f32Load).memoryArgument(2, innerOffset * 4);
  if (splat) body.simd(simdOpcode.f32x4Splat);
}

function initializeVectorInnerPointers(
  body: ByteWriter,
  plan: NormalizedF32GemmPlan,
  rowTile: number,
): void {
  for (let rowOffset = 0; rowOffset < rowTile; rowOffset++) {
    emitMatrixRowAddress(body, A_POINTER, ROW_LOCAL, plan.inner, rowOffset);
    body.instruction(opcode.localSet).unsigned(A_INNER_POINTER_LOCAL_BASE + rowOffset);
  }
  emitRightPanelAddress(body, plan);
  body.instruction(opcode.localSet).unsigned(B_INNER_POINTER_LOCAL);
}

function initializeScalarInnerPointers(
  body: ByteWriter,
  plan: NormalizedF32GemmPlan,
  rowOffset: number,
): void {
  emitMatrixRowAddress(body, A_POINTER, ROW_LOCAL, plan.inner, rowOffset);
  body.instruction(opcode.localSet).unsigned(A_INNER_POINTER_LOCAL_BASE + rowOffset);
  emitRightPanelAddress(body, plan);
  body.instruction(opcode.localSet).unsigned(B_INNER_POINTER_LOCAL);
}

function incrementInnerPointers(
  body: ByteWriter,
  rowTile: number,
  factor: number,
  columns: number,
  firstRowOffset = 0,
): void {
  for (let row = 0; row < rowTile; row++) {
    increment(body, A_INNER_POINTER_LOCAL_BASE + firstRowOffset + row, factor * 4);
  }
  increment(body, B_INNER_POINTER_LOCAL, factor * columns * 4);
}

function rightInnerStride(plan: NormalizedF32GemmPlan): number {
  return plan.rightLayout === "packed-panels" ? VECTOR_TILE * 4 / plan.rowTile : plan.columns;
}

function emitRightPanelAddress(body: ByteWriter, plan: NormalizedF32GemmPlan): void {
  if (plan.rightLayout === "row-major") {
    emitVectorAddress(body, B_POINTER, COLUMN_LOCAL);
    return;
  }
  const panelColumns = rightInnerStride(plan);
  const panelShift = Math.log2(panelColumns);
  body.instruction(opcode.localGet).unsigned(B_POINTER);
  body.instruction(opcode.localGet).unsigned(COLUMN_LOCAL);
  body.instruction(opcode.i32Constant).signed(panelShift);
  body.instruction(opcode.i32ShiftRightUnsigned);
  body.instruction(opcode.i32Constant).signed(plan.inner * panelColumns * 4);
  body.instruction(opcode.i32Multiply);
  body.instruction(opcode.i32Add);
  body.instruction(opcode.localGet).unsigned(COLUMN_LOCAL);
  body.instruction(opcode.i32Constant).signed(panelColumns - 1);
  body.instruction(opcode.i32And);
  body.instruction(opcode.i32Constant).signed(2);
  body.instruction(opcode.i32ShiftLeft);
  body.instruction(opcode.i32Add);
}

function innerUnrollFactor(plan: NormalizedF32GemmPlan): number {
  if (plan.innerLoop === "unroll2") return 2;
  if (plan.innerLoop === "unroll4") return 4;
  return 1;
}

function emitVectorEpilogue(
  body: ByteWriter,
  plan: NormalizedF32GemmPlan,
  columnOffset: number,
  rowOffset: number,
): void {
  if (plan.alpha !== 1) {
    body.instruction(opcode.f32Constant).float32(plan.alpha);
    body.simd(simdOpcode.f32x4Splat);
    body.simd(simdOpcode.f32x4Multiply);
  }
  if (plan.beta !== 0) {
    emitMatrixAddress(
      body,
      C_POINTER,
      ROW_LOCAL,
      plan.columns,
      COLUMN_LOCAL,
      columnOffset,
      rowOffset,
    );
    body.simd(simdOpcode.v128Load).memoryArgument(4);
    if (plan.beta !== 1) {
      body.instruction(opcode.f32Constant).float32(plan.beta);
      body.simd(simdOpcode.f32x4Splat);
      body.simd(simdOpcode.f32x4Multiply);
    }
    body.simd(simdOpcode.f32x4Add);
  }
  if (plan.bias.kind === "columns") {
    emitVectorAddress(body, BIAS_POINTER, COLUMN_LOCAL, columnOffset);
    body.simd(simdOpcode.v128Load).memoryArgument(4);
    body.simd(simdOpcode.f32x4Add);
  } else if (plan.bias.kind === "scalar") {
    body.instruction(opcode.f32Constant).float32(plan.bias.value);
    body.simd(simdOpcode.f32x4Splat);
    body.simd(simdOpcode.f32x4Add);
  }
  if (plan.activation.kind === "relu") {
    body.instruction(opcode.f32Constant).float32(0);
    body.simd(simdOpcode.f32x4Splat);
    body.simd(simdOpcode.f32x4Maximum);
  } else if (plan.activation.kind === "clamp") {
    body.instruction(opcode.f32Constant).float32(plan.activation.minimum);
    body.simd(simdOpcode.f32x4Splat);
    body.simd(simdOpcode.f32x4Maximum);
    body.instruction(opcode.f32Constant).float32(plan.activation.maximum);
    body.simd(simdOpcode.f32x4Splat);
    body.simd(simdOpcode.f32x4Minimum);
  }
}

function emitScalarEpilogue(
  body: ByteWriter,
  plan: NormalizedF32GemmPlan,
  rowOffset: number,
): void {
  if (plan.alpha !== 1) {
    body.instruction(opcode.f32Constant).float32(plan.alpha);
    body.instruction(opcode.f32Multiply);
  }
  if (plan.beta !== 0) {
    emitMatrixAddress(body, C_POINTER, ROW_LOCAL, plan.columns, COLUMN_LOCAL, 0, rowOffset);
    body.instruction(opcode.f32Load).memoryArgument(2);
    if (plan.beta !== 1) {
      body.instruction(opcode.f32Constant).float32(plan.beta);
      body.instruction(opcode.f32Multiply);
    }
    body.instruction(opcode.f32Add);
  }
  if (plan.bias.kind === "columns") {
    emitVectorAddress(body, BIAS_POINTER, COLUMN_LOCAL);
    body.instruction(opcode.f32Load).memoryArgument(2);
    body.instruction(opcode.f32Add);
  } else if (plan.bias.kind === "scalar") {
    body.instruction(opcode.f32Constant).float32(plan.bias.value);
    body.instruction(opcode.f32Add);
  }
  if (plan.activation.kind === "relu") {
    body.instruction(opcode.f32Constant).float32(0);
    body.instruction(opcode.f32Maximum);
  } else if (plan.activation.kind === "clamp") {
    body.instruction(opcode.f32Constant).float32(plan.activation.minimum);
    body.instruction(opcode.f32Maximum);
    body.instruction(opcode.f32Constant).float32(plan.activation.maximum);
    body.instruction(opcode.f32Minimum);
  }
}

function emitMatrixAddress(
  body: ByteWriter,
  pointerParameter: number,
  majorLocal: number,
  stride: number,
  minorLocal: number,
  minorOffset = 0,
  majorOffset = 0,
): void {
  body.instruction(opcode.localGet).unsigned(pointerParameter);
  body.instruction(opcode.localGet).unsigned(majorLocal);
  if (majorOffset !== 0) {
    body.instruction(opcode.i32Constant).signed(majorOffset);
    body.instruction(opcode.i32Add);
  }
  body.instruction(opcode.i32Constant).signed(stride);
  body.instruction(opcode.i32Multiply);
  body.instruction(opcode.localGet).unsigned(minorLocal);
  body.instruction(opcode.i32Add);
  if (minorOffset !== 0) {
    body.instruction(opcode.i32Constant).signed(minorOffset);
    body.instruction(opcode.i32Add);
  }
  body.instruction(opcode.i32Constant).signed(2);
  body.instruction(opcode.i32ShiftLeft);
  body.instruction(opcode.i32Add);
}

function emitMatrixRowAddress(
  body: ByteWriter,
  pointerParameter: number,
  rowLocal: number,
  stride: number,
  rowOffset: number,
): void {
  body.instruction(opcode.localGet).unsigned(pointerParameter);
  body.instruction(opcode.localGet).unsigned(rowLocal);
  if (rowOffset !== 0) {
    body.instruction(opcode.i32Constant).signed(rowOffset);
    body.instruction(opcode.i32Add);
  }
  body.instruction(opcode.i32Constant).signed(stride);
  body.instruction(opcode.i32Multiply);
  body.instruction(opcode.i32Constant).signed(2);
  body.instruction(opcode.i32ShiftLeft);
  body.instruction(opcode.i32Add);
}

function accumulatorLocal(rowOffset: number, vector: number, vectorCount: number): number {
  return VECTOR_ACCUMULATOR_BASE + rowOffset * vectorCount + vector;
}

function emitVectorAddress(
  body: ByteWriter,
  pointerParameter: number,
  indexLocal: number,
  indexOffset = 0,
): void {
  body.instruction(opcode.localGet).unsigned(pointerParameter);
  body.instruction(opcode.localGet).unsigned(indexLocal);
  if (indexOffset !== 0) {
    body.instruction(opcode.i32Constant).signed(indexOffset);
    body.instruction(opcode.i32Add);
  }
  body.instruction(opcode.i32Constant).signed(2);
  body.instruction(opcode.i32ShiftLeft);
  body.instruction(opcode.i32Add);
}

function beginLoop(body: ByteWriter): void {
  body.instruction(opcode.block).byte(EMPTY_BLOCK);
  body.instruction(opcode.loop).byte(EMPTY_BLOCK);
}

function endLoop(body: ByteWriter): void {
  body.instruction(opcode.end);
  body.instruction(opcode.end);
}

function branchIfAtLeastConstant(
  body: ByteWriter,
  local: number,
  limit: number,
  depth: number,
): void {
  body.instruction(opcode.localGet).unsigned(local);
  body.instruction(opcode.i32Constant).signed(limit);
  body.instruction(opcode.i32GreaterEqualUnsigned);
  body.instruction(opcode.branchIf).unsigned(depth);
}

function branchIfAtLeast(
  body: ByteWriter,
  local: number,
  limit: number | Readonly<{ local: number }>,
  depth: number,
): void {
  body.instruction(opcode.localGet).unsigned(local);
  if (typeof limit === "number") {
    body.instruction(opcode.i32Constant).signed(limit);
  } else {
    body.instruction(opcode.localGet).unsigned(limit.local);
  }
  body.instruction(opcode.i32GreaterEqualUnsigned);
  body.instruction(opcode.branchIf).unsigned(depth);
}

function setI32(body: ByteWriter, local: number, value: number): void {
  body.instruction(opcode.i32Constant).signed(value);
  body.instruction(opcode.localSet).unsigned(local);
}

function copyI32(body: ByteWriter, target: number, source: number): void {
  body.instruction(opcode.localGet).unsigned(source);
  body.instruction(opcode.localSet).unsigned(target);
}

function increment(body: ByteWriter, local: number, value: number): void {
  body.instruction(opcode.localGet).unsigned(local);
  body.instruction(opcode.i32Constant).signed(value);
  body.instruction(opcode.i32Add);
  body.instruction(opcode.localSet).unsigned(local);
}
