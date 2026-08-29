export type F32Expression =
  | Readonly<{ kind: "input"; index: number }>
  | Readonly<{ kind: "constant"; value: number }>
  | Readonly<{ kind: "absolute"; value: F32Expression }>
  | Readonly<{
    kind: "add" | "multiply" | "minimum" | "maximum";
    left: F32Expression;
    right: F32Expression;
  }>;

export function input(index: number): F32Expression {
  return Object.freeze({ kind: "input", index });
}

export function constant(value: number): F32Expression {
  return Object.freeze({ kind: "constant", value });
}

export function absolute(value: F32Expression): F32Expression {
  return Object.freeze({ kind: "absolute", value });
}

export function add(left: F32Expression, right: F32Expression): F32Expression {
  return Object.freeze({ kind: "add", left, right });
}

export function multiply(left: F32Expression, right: F32Expression): F32Expression {
  return Object.freeze({ kind: "multiply", left, right });
}

export function minimum(left: F32Expression, right: F32Expression): F32Expression {
  return Object.freeze({ kind: "minimum", left, right });
}

export function maximum(left: F32Expression, right: F32Expression): F32Expression {
  return Object.freeze({ kind: "maximum", left, right });
}

export function relu(value: F32Expression): F32Expression {
  return maximum(constant(0), value);
}

export function validateExpression(expression: F32Expression, inputCount: number): void {
  if (!Number.isInteger(inputCount) || inputCount < 1 || inputCount > 8) {
    throw new RangeError("inputCount must be an integer between 1 and 8");
  }
  validateNode(expression, inputCount, 1, { nodes: 0 });
}

export function expressionKey(expression: F32Expression, inputCount: number): string {
  return `${inputCount}:${nodeKey(expression)}`;
}

function validateNode(
  expression: F32Expression,
  inputCount: number,
  depth: number,
  state: { nodes: number },
): void {
  if (depth > 64) throw new RangeError("expression depth must not exceed 64");
  state.nodes++;
  if (state.nodes > 1024) throw new RangeError("expression must not exceed 1024 nodes");

  switch (expression.kind) {
    case "input":
      if (
        !Number.isInteger(expression.index) || expression.index < 0 ||
        expression.index >= inputCount
      ) {
        throw new RangeError(`input index ${expression.index} is outside [0, ${inputCount})`);
      }
      return;
    case "constant":
      if (!Number.isFinite(expression.value)) {
        throw new RangeError("constant value must be finite");
      }
      return;
    case "absolute":
      validateNode(expression.value, inputCount, depth + 1, state);
      return;
    default:
      validateNode(expression.left, inputCount, depth + 1, state);
      validateNode(expression.right, inputCount, depth + 1, state);
  }
}

function nodeKey(expression: F32Expression): string {
  switch (expression.kind) {
    case "input":
      return `i${expression.index}`;
    case "constant":
      return `c${f32Bits(expression.value).toString(16).padStart(8, "0")}`;
    case "absolute":
      return `abs(${nodeKey(expression.value)})`;
    default:
      return `${expression.kind}(${nodeKey(expression.left)},${nodeKey(expression.right)})`;
  }
}

function f32Bits(value: number): number {
  const bytes = new ArrayBuffer(4);
  const view = new DataView(bytes);
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
}
