import type { F32Expression } from "./expression.ts";
import { ByteWriter, emitImportedMemoryModule, EMPTY_BLOCK, I32 } from "./wasm_binary.ts";

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
  i32GreaterUnsigned: 0x4b,
  i32GreaterEqualUnsigned: 0x4f,
  i32Add: 0x6a,
  i32ShiftLeft: 0x74,
  f32Absolute: 0x8b,
  f32Add: 0x92,
  f32Multiply: 0x94,
  f32Minimum: 0x96,
  f32Maximum: 0x97,
} as const;

const simdOpcode = {
  v128Load: 0x00,
  v128Store: 0x0b,
  f32x4Splat: 0x13,
  f32x4Absolute: 0xe0,
  f32x4Add: 0xe4,
  f32x4Multiply: 0xe6,
  f32x4Minimum: 0xe8,
  f32x4Maximum: 0xe9,
} as const;

export function emitF32MapModule(
  expression: F32Expression,
  inputCount: number,
): Uint8Array<ArrayBuffer> {
  const outputParameter = inputCount;
  const lengthParameter = inputCount + 1;
  const indexLocal = inputCount + 2;
  const body = new ByteWriter();

  // One i32 local holds the current element index.
  body.vector([[1, I32]]);
  body.instruction(opcode.i32Constant).signed(0);
  body.instruction(opcode.localSet).unsigned(indexLocal);

  // SIMD loop: four f32 values per iteration.
  body.instruction(opcode.block).byte(EMPTY_BLOCK);
  body.instruction(opcode.loop).byte(EMPTY_BLOCK);
  body.instruction(opcode.localGet).unsigned(indexLocal);
  body.instruction(opcode.i32Constant).signed(4);
  body.instruction(opcode.i32Add);
  body.instruction(opcode.localGet).unsigned(lengthParameter);
  body.instruction(opcode.i32GreaterUnsigned);
  body.instruction(opcode.branchIf).unsigned(1);
  emitAddress(body, outputParameter, indexLocal);
  emitVectorExpression(body, expression, indexLocal);
  body.simd(simdOpcode.v128Store).memoryArgument(4);
  body.instruction(opcode.localGet).unsigned(indexLocal);
  body.instruction(opcode.i32Constant).signed(4);
  body.instruction(opcode.i32Add);
  body.instruction(opcode.localSet).unsigned(indexLocal);
  body.instruction(opcode.branch).unsigned(0);
  body.instruction(opcode.end);
  body.instruction(opcode.end);

  // Scalar tail: handles lengths which are not divisible by four.
  body.instruction(opcode.block).byte(EMPTY_BLOCK);
  body.instruction(opcode.loop).byte(EMPTY_BLOCK);
  body.instruction(opcode.localGet).unsigned(indexLocal);
  body.instruction(opcode.localGet).unsigned(lengthParameter);
  body.instruction(opcode.i32GreaterEqualUnsigned);
  body.instruction(opcode.branchIf).unsigned(1);
  emitAddress(body, outputParameter, indexLocal);
  emitScalarExpression(body, expression, indexLocal);
  body.instruction(opcode.f32Store).memoryArgument(2);
  body.instruction(opcode.localGet).unsigned(indexLocal);
  body.instruction(opcode.i32Constant).signed(1);
  body.instruction(opcode.i32Add);
  body.instruction(opcode.localSet).unsigned(indexLocal);
  body.instruction(opcode.branch).unsigned(0);
  body.instruction(opcode.end);
  body.instruction(opcode.end);
  body.instruction(opcode.end);

  return emitImportedMemoryModule(Array.from({ length: inputCount + 2 }, () => I32), body);
}

function emitAddress(writer: ByteWriter, pointerParameter: number, indexLocal: number): void {
  writer.instruction(opcode.localGet).unsigned(pointerParameter);
  writer.instruction(opcode.localGet).unsigned(indexLocal);
  writer.instruction(opcode.i32Constant).signed(2);
  writer.instruction(opcode.i32ShiftLeft);
  writer.instruction(opcode.i32Add);
}

function emitVectorExpression(
  writer: ByteWriter,
  expression: F32Expression,
  indexLocal: number,
): void {
  switch (expression.kind) {
    case "input":
      emitAddress(writer, expression.index, indexLocal);
      writer.simd(simdOpcode.v128Load).memoryArgument(4);
      return;
    case "constant":
      writer.instruction(opcode.f32Constant).float32(expression.value);
      writer.simd(simdOpcode.f32x4Splat);
      return;
    case "absolute":
      emitVectorExpression(writer, expression.value, indexLocal);
      writer.simd(simdOpcode.f32x4Absolute);
      return;
    default:
      emitVectorExpression(writer, expression.left, indexLocal);
      emitVectorExpression(writer, expression.right, indexLocal);
      writer.simd(vectorBinaryOpcode(expression.kind));
  }
}

function emitScalarExpression(
  writer: ByteWriter,
  expression: F32Expression,
  indexLocal: number,
): void {
  switch (expression.kind) {
    case "input":
      emitAddress(writer, expression.index, indexLocal);
      writer.instruction(opcode.f32Load).memoryArgument(2);
      return;
    case "constant":
      writer.instruction(opcode.f32Constant).float32(expression.value);
      return;
    case "absolute":
      emitScalarExpression(writer, expression.value, indexLocal);
      writer.instruction(opcode.f32Absolute);
      return;
    default:
      emitScalarExpression(writer, expression.left, indexLocal);
      emitScalarExpression(writer, expression.right, indexLocal);
      writer.instruction(scalarBinaryOpcode(expression.kind));
  }
}

function vectorBinaryOpcode(kind: "add" | "multiply" | "minimum" | "maximum"): number {
  switch (kind) {
    case "add":
      return simdOpcode.f32x4Add;
    case "multiply":
      return simdOpcode.f32x4Multiply;
    case "minimum":
      return simdOpcode.f32x4Minimum;
    case "maximum":
      return simdOpcode.f32x4Maximum;
  }
}

function scalarBinaryOpcode(kind: "add" | "multiply" | "minimum" | "maximum"): number {
  switch (kind) {
    case "add":
      return opcode.f32Add;
    case "multiply":
      return opcode.f32Multiply;
    case "minimum":
      return opcode.f32Minimum;
    case "maximum":
      return opcode.f32Maximum;
  }
}
