import type {
  IntegerAction,
  MaxLengthAction,
  MaxValueAction,
  MinLengthAction,
  MinValueAction,
} from "./types.ts";

export function integer(): IntegerAction {
  return { kind: "integer" };
}

export function minValue(requirement: number): MinValueAction {
  finite(requirement, "minValue");
  return { kind: "min_value", requirement };
}

export function maxValue(requirement: number): MaxValueAction {
  finite(requirement, "maxValue");
  return { kind: "max_value", requirement };
}

export function minLength(requirement: number): MinLengthAction {
  length(requirement, "minLength");
  return { kind: "min_length", requirement };
}

export function maxLength(requirement: number): MaxLengthAction {
  length(requirement, "maxLength");
  return { kind: "max_length", requirement };
}

function finite(requirement: number, name: string): void {
  if (!Number.isFinite(requirement)) throw new RangeError(`${name} requires a finite number`);
}

function length(requirement: number, name: string): void {
  if (!Number.isSafeInteger(requirement) || requirement < 0) {
    throw new RangeError(`${name} requires a non-negative safe integer`);
  }
}
