export interface NumericRangeOptions {
  readonly min?: number;
  readonly max?: number;
}

export interface NumericSchema {
  readonly type: "integer" | "number";
  readonly minimum: number;
  readonly maximum: number;
}

export interface StringOptions {
  readonly minLength?: number;
  readonly maxLength: number;
}

export interface StringSchema {
  readonly type: "string";
  readonly minLength?: number;
  readonly maxLength: number;
}

export interface ArrayOptions {
  readonly minLength?: number;
  readonly maxLength: number;
}

export interface ArraySchema {
  readonly type: "array";
  readonly items: FieldSchema;
  readonly minItems?: number;
  readonly maxItems: number;
}

export type FieldSchema = NumericSchema | StringSchema | ArraySchema | StrictObjectSchema;

export interface StrictObjectSchema<
  Shape extends Readonly<Record<string, FieldSchema>> = Readonly<Record<string, FieldSchema>>,
> {
  readonly type: "object";
  readonly properties: Shape;
  readonly required: readonly (keyof Shape & string)[];
  readonly additionalProperties: false;
}

const F32_MAX = 3.4028234663852886e38;

export function u8(options: NumericRangeOptions = {}): NumericSchema {
  return integerSchema("u8", 0, 255, options);
}

export function u16(options: NumericRangeOptions = {}): NumericSchema {
  return integerSchema("u16", 0, 65_535, options);
}

export function u32(options: NumericRangeOptions = {}): NumericSchema {
  return integerSchema("u32", 0, 4_294_967_295, options);
}

export function i8(options: NumericRangeOptions = {}): NumericSchema {
  return integerSchema("i8", -128, 127, options);
}

export function i16(options: NumericRangeOptions = {}): NumericSchema {
  return integerSchema("i16", -32_768, 32_767, options);
}

export function i32(options: NumericRangeOptions = {}): NumericSchema {
  return integerSchema("i32", -2_147_483_648, 2_147_483_647, options);
}

export function f32(options: NumericRangeOptions = {}): NumericSchema {
  return numberSchema("f32", -F32_MAX, F32_MAX, options);
}

export function f64(options: NumericRangeOptions = {}): NumericSchema {
  return numberSchema("f64", -Number.MAX_VALUE, Number.MAX_VALUE, options);
}

export function string(options: StringOptions): StringSchema {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new TypeError("string options must be an object");
  }
  for (const key of Object.keys(options)) {
    if (key !== "minLength" && key !== "maxLength") {
      throw new TypeError(`string option ${key} is not supported`);
    }
  }
  if (options.maxLength === undefined) throw new TypeError("string maxLength is required");
  validateLength("string", "maxLength", options.maxLength);
  if (options.minLength !== undefined) validateLength("string", "minLength", options.minLength);
  if ((options.minLength ?? 0) > options.maxLength) {
    throw new TypeError("string minLength must not exceed maxLength");
  }
  return {
    type: "string",
    ...(options.minLength === undefined ? {} : { minLength: options.minLength }),
    maxLength: options.maxLength,
  };
}

export function array(item: FieldSchema, options: ArrayOptions): ArraySchema {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new TypeError("array options must be an object");
  }
  for (const key of Object.keys(options)) {
    if (key !== "minLength" && key !== "maxLength") {
      throw new TypeError(`array option ${key} is not supported`);
    }
  }
  if (options.maxLength === undefined) throw new TypeError("array maxLength is required");
  validateLength("array", "maxLength", options.maxLength);
  if (options.minLength !== undefined) validateLength("array", "minLength", options.minLength);
  if ((options.minLength ?? 0) > options.maxLength) {
    throw new TypeError("array minLength must not exceed maxLength");
  }
  return {
    type: "array",
    items: item,
    ...(options.minLength === undefined ? {} : { minItems: options.minLength }),
    maxItems: options.maxLength,
  };
}

export function strictObject<const Shape extends Readonly<Record<string, FieldSchema>>>(
  shape: Shape,
): StrictObjectSchema<Shape> {
  const properties = { ...shape } as Shape;
  return {
    type: "object",
    properties,
    required: Object.keys(properties) as (keyof Shape & string)[],
    additionalProperties: false,
  };
}

function validateLength(
  schema: "array" | "string",
  key: "minLength" | "maxLength",
  value: number,
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${schema} ${key} must be a non-negative integer`);
  }
}

function integerSchema(
  name: string,
  intrinsicMin: number,
  intrinsicMax: number,
  options: NumericRangeOptions,
): NumericSchema {
  const { min, max } = range(name, intrinsicMin, intrinsicMax, options, true);
  return { type: "integer", minimum: min, maximum: max };
}

function numberSchema(
  name: string,
  intrinsicMin: number,
  intrinsicMax: number,
  options: NumericRangeOptions,
): NumericSchema {
  const { min, max } = range(name, intrinsicMin, intrinsicMax, options, false);
  return { type: "number", minimum: min, maximum: max };
}

function range(
  name: string,
  intrinsicMin: number,
  intrinsicMax: number,
  options: NumericRangeOptions,
  integer: boolean,
): { readonly min: number; readonly max: number } {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new TypeError(`${name} options must be an object`);
  }
  for (const key of Object.keys(options)) {
    if (key !== "min" && key !== "max") {
      throw new TypeError(`${name} option ${key} is not supported`);
    }
  }
  const min = options.min ?? intrinsicMin;
  const max = options.max ?? intrinsicMax;
  validateBound(name, "min", min, intrinsicMin, intrinsicMax, integer);
  validateBound(name, "max", max, intrinsicMin, intrinsicMax, integer);
  if (min > max) throw new TypeError(`${name} min must not exceed max`);
  return { min, max };
}

function validateBound(
  name: string,
  key: "min" | "max",
  value: number,
  intrinsicMin: number,
  intrinsicMax: number,
  integer: boolean,
): void {
  if (!Number.isFinite(value)) throw new TypeError(`${name} ${key} must be finite`);
  if (integer && !Number.isInteger(value)) {
    throw new TypeError(`${name} ${key} must be an integer`);
  }
  if (value < intrinsicMin || value > intrinsicMax) {
    throw new TypeError(`${name} ${key} must be between ${intrinsicMin} and ${intrinsicMax}`);
  }
}
