import type { IssueArguments, ValidationIssue } from "../diagnostics.ts";

export interface SimdMinValueAction {
  readonly kind: "min_value";
  readonly requirement: number;
}

export interface SimdMaxValueAction {
  readonly kind: "max_value";
  readonly requirement: number;
}

export function minValue(requirement: number): SimdMinValueAction {
  finiteRequirement(requirement, "minValue");
  return { kind: "min_value", requirement };
}

export function maxValue(requirement: number): SimdMaxValueAction {
  finiteRequirement(requirement, "maxValue");
  return { kind: "max_value", requirement };
}

export type SimdElementAction = SimdMinValueAction | SimdMaxValueAction;
export type SimdIssue = Extract<
  ValidationIssue,
  { readonly code: "type" | "min_value" | "max_value" }
>;
export type SimdSafeParseResult<Output> =
  | { readonly success: true; readonly output: Output }
  | { readonly success: false; readonly issues: readonly [SimdIssue] };
export type SimdIntegerArray = Int32Array | Uint32Array | Uint8Array;
export type SimdFloatArray = Float32Array | Float64Array;
export type SimdNumericArray = SimdIntegerArray | SimdFloatArray;
export type SimdArrayKind = "i32" | "u32" | "u8" | "f32" | "f64";

export interface SimdArrayConstructor<Output extends SimdNumericArray> {
  readonly BYTES_PER_ELEMENT: number;
  readonly name: string;
  new (length: number): Output;
  new (buffer: ArrayBufferLike, byteOffset?: number, length?: number): Output;
}

export interface SimdArraySchema<Output extends SimdNumericArray> {
  readonly kind: SimdArrayKind;
  readonly actions: readonly SimdElementAction[];
  readonly arrayType: SimdArrayConstructor<Output>;
}

export interface ResidentSimdInput<Output extends SimdNumericArray> {
  readonly input: Output;
  firstInvalid(): number;
  is(): boolean;
  safeParse(): SimdSafeParseResult<Output>;
}

export interface SimdValidator<Output extends SimdNumericArray> {
  readonly schema: SimdArraySchema<Output>;
  firstInvalid(input: Output): number;
  is(input: unknown): input is Output;
  safeParse(input: unknown): SimdSafeParseResult<Output>;
  resident(length: number): ResidentSimdInput<Output>;
}

export function int32Array(
  ...actions: readonly SimdElementAction[]
): SimdArraySchema<Int32Array> {
  return schema("i32", Int32Array, actions);
}

export function uint32Array(
  ...actions: readonly SimdElementAction[]
): SimdArraySchema<Uint32Array> {
  return schema("u32", Uint32Array, actions);
}

export function uint8Array(
  ...actions: readonly SimdElementAction[]
): SimdArraySchema<Uint8Array> {
  return schema("u8", Uint8Array, actions);
}

export function float32Array(
  ...actions: readonly SimdElementAction[]
): SimdArraySchema<Float32Array> {
  return schema("f32", Float32Array, actions);
}

export function float64Array(
  ...actions: readonly SimdElementAction[]
): SimdArraySchema<Float64Array> {
  return schema("f64", Float64Array, actions);
}

export async function compileSimd<Output extends SimdNumericArray>(
  inputSchema: SimdArraySchema<Output>,
): Promise<SimdValidator<Output>> {
  const module = await compileModule();
  const instance = await WebAssembly.instantiate(module);
  const exports = instance.exports as unknown as KernelExports;
  const bounds = effectiveBounds(inputSchema);
  const scan = scanner(exports, inputSchema.kind);
  const bytesPerElement = inputSchema.arrayType.BYTES_PER_ELEMENT;

  function ensureCapacity(length: number): void {
    validateLength(length, bytesPerElement);
    const requiredBytes = length * bytesPerElement;
    if (requiredBytes <= exports.memory.buffer.byteLength) return;
    exports.memory.grow(
      Math.ceil((requiredBytes - exports.memory.buffer.byteLength) / WASM_PAGE_BYTES),
    );
  }

  function view(length: number): Output {
    ensureCapacity(length);
    return new inputSchema.arrayType(exports.memory.buffer, 0, length);
  }

  function scanResident(length: number): number {
    if (length === 0) return -1;
    if (
      inputSchema.actions.length === 0 &&
      inputSchema.kind !== "f32" && inputSchema.kind !== "f64"
    ) return -1;
    if (bounds.impossible) return 0;
    return scan(0, length, bounds.minimum, bounds.maximum);
  }

  function firstInvalid(input: Output): number {
    if (!(input instanceof inputSchema.arrayType)) {
      throw new TypeError(`expected ${inputSchema.arrayType.name}`);
    }
    const residentView = view(input.length);
    residentView.set(input);
    return scanResident(input.length);
  }

  function safeParse(input: unknown): SimdSafeParseResult<Output> {
    if (!(input instanceof inputSchema.arrayType)) {
      return failure("type", [inputSchema.arrayType.name], []);
    }
    const index = firstInvalid(input);
    return index === -1
      ? { success: true, output: input }
      : diagnose(input, index, inputSchema.actions);
  }

  return {
    schema: inputSchema,
    firstInvalid,
    is(input: unknown): input is Output {
      return input instanceof inputSchema.arrayType && firstInvalid(input) === -1;
    },
    safeParse,
    resident(length: number): ResidentSimdInput<Output> {
      const input = view(length);
      const buffer = exports.memory.buffer;
      const assertCurrent = (): void => {
        if (input.buffer !== exports.memory.buffer || buffer !== exports.memory.buffer) {
          throw new Error("resident input is stale after Wasm memory growth");
        }
      };
      const residentFirstInvalid = (): number => {
        assertCurrent();
        return scanResident(length);
      };
      return {
        input,
        firstInvalid: residentFirstInvalid,
        is: () => residentFirstInvalid() === -1,
        safeParse: () => {
          const index = residentFirstInvalid();
          return index === -1
            ? { success: true, output: input }
            : diagnose(input, index, inputSchema.actions);
        },
      };
    },
  };
}

const WASM_PAGE_BYTES = 65_536;

interface KernelExports {
  readonly memory: WebAssembly.Memory;
  readonly first_i32_outside: ScanFunction;
  readonly first_u32_outside: ScanFunction;
  readonly first_u8_outside: ScanFunction;
  readonly first_f32_outside: ScanFunction;
  readonly first_f64_outside: ScanFunction;
}

type ScanFunction = (
  pointer: number,
  length: number,
  minimum: number,
  maximum: number,
) => number;

interface EffectiveBounds {
  readonly minimum: number;
  readonly maximum: number;
  readonly impossible: boolean;
}

function schema<Output extends SimdNumericArray>(
  kind: SimdArrayKind,
  arrayType: SimdArrayConstructor<Output>,
  actions: readonly SimdElementAction[],
): SimdArraySchema<Output> {
  const normalizedActions = actions.map((action, index): SimdElementAction => {
    if (
      typeof action !== "object" || action === null ||
      (action.kind !== "min_value" && action.kind !== "max_value")
    ) throw new TypeError(`invalid SIMD action ${index}`);
    return action.kind === "min_value"
      ? minValue(action.requirement)
      : maxValue(action.requirement);
  });
  return { kind, arrayType, actions: normalizedActions };
}

function effectiveBounds<Output extends SimdNumericArray>(
  inputSchema: SimdArraySchema<Output>,
): EffectiveBounds {
  const [domainMinimum, domainMaximum] = domainBounds(inputSchema.kind);
  let minimum = domainMinimum;
  let maximum = domainMaximum;
  for (const action of inputSchema.actions) {
    if (action.kind === "min_value") minimum = Math.max(minimum, action.requirement);
    else maximum = Math.min(maximum, action.requirement);
  }
  if (inputSchema.kind === "i32" || inputSchema.kind === "u32" || inputSchema.kind === "u8") {
    minimum = Math.ceil(minimum);
    maximum = Math.floor(maximum);
  } else if (inputSchema.kind === "f32") {
    minimum = float32Ceiling(minimum);
    maximum = float32Floor(maximum);
  }
  return {
    minimum,
    maximum,
    impossible: minimum > maximum || minimum > domainMaximum || maximum < domainMinimum,
  };
}

function scanner(exports: KernelExports, kind: SimdArrayKind): ScanFunction {
  if (kind === "i32") return exports.first_i32_outside;
  if (kind === "u32") return exports.first_u32_outside;
  if (kind === "u8") return exports.first_u8_outside;
  if (kind === "f32") return exports.first_f32_outside;
  return exports.first_f64_outside;
}

function diagnose<Output extends SimdNumericArray>(
  input: Output,
  index: number,
  actions: readonly SimdElementAction[],
): SimdSafeParseResult<Output> {
  const received = input[index];
  if (!Number.isFinite(received)) {
    return failure("type", ["finite number"], [index]);
  }
  for (const action of actions) {
    if (action.kind === "min_value" && received < action.requirement) {
      return failure("min_value", [action.requirement], [index]);
    }
    if (action.kind === "max_value" && received > action.requirement) {
      return failure("max_value", [action.requirement], [index]);
    }
  }
  throw new Error("SIMD predicate and diagnostic diverged");
}

const FLOAT32_MAX = 3.4028234663852886e38;

function domainBounds(kind: SimdArrayKind): readonly [number, number] {
  if (kind === "i32") return [-0x8000_0000, 0x7fff_ffff];
  if (kind === "u32") return [0, 0xffff_ffff];
  if (kind === "u8") return [0, 0xff];
  if (kind === "f32") return [-FLOAT32_MAX, FLOAT32_MAX];
  return [-Number.MAX_VALUE, Number.MAX_VALUE];
}

function float32Ceiling(value: number): number {
  const rounded = Math.fround(value);
  return rounded < value ? adjacentFloat32(rounded, 1) : rounded;
}

function float32Floor(value: number): number {
  const rounded = Math.fround(value);
  return rounded > value ? adjacentFloat32(rounded, -1) : rounded;
}

function adjacentFloat32(value: number, direction: -1 | 1): number {
  if (direction === 1 && value === Number.POSITIVE_INFINITY) return value;
  if (direction === -1 && value === Number.NEGATIVE_INFINITY) return value;
  if (direction === 1 && value === Number.NEGATIVE_INFINITY) return -FLOAT32_MAX;
  if (direction === -1 && value === Number.POSITIVE_INFINITY) return FLOAT32_MAX;
  if (value === 0) return direction === 1 ? 2 ** -149 : -(2 ** -149);

  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value);
  const bits = view.getUint32(0);
  view.setUint32(0, bits + ((value > 0) === (direction > 0) ? 1 : -1));
  return view.getFloat32(0);
}

function failure<Output, Code extends SimdIssue["code"]>(
  code: Code,
  args: IssueArguments[Code],
  path: readonly (string | number)[],
): SimdSafeParseResult<Output> {
  return {
    success: false,
    issues: [{ code, args, path } as Extract<ValidationIssue, { readonly code: Code }>],
  };
}

function validateLength(length: number, bytesPerElement: number): void {
  if (
    !Number.isSafeInteger(length) || length < 0 ||
    length * bytesPerElement > 0xffff_0000
  ) {
    throw new RangeError("length exceeds the Wasm32 address space");
  }
}

function finiteRequirement(requirement: number, name: string): void {
  if (!Number.isFinite(requirement)) throw new RangeError(`${name} requires a finite number`);
}

let modulePromise: Promise<WebAssembly.Module> | undefined;

function compileModule(): Promise<WebAssembly.Module> {
  return modulePromise ??= loadModule(new URL("./kernels.wasm", import.meta.url));
}

async function loadModule(url: URL): Promise<WebAssembly.Module> {
  const deno = (globalThis as typeof globalThis & {
    Deno?: { readFile(path: URL): Promise<Uint8Array> };
  }).Deno;
  if (url.protocol === "file:" && deno !== undefined) {
    return await WebAssembly.compile(await deno.readFile(url) as BufferSource);
  }

  interface NodeProcess {
    getBuiltinModule?(name: string): { readFileSync(path: URL): Uint8Array };
  }
  const nodeProcess = (globalThis as typeof globalThis & { process?: NodeProcess }).process;
  const fileSystem = nodeProcess?.getBuiltinModule?.("node:fs");
  if (url.protocol === "file:" && fileSystem !== undefined) {
    return new WebAssembly.Module(fileSystem.readFileSync(url) as BufferSource);
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to load validator SIMD module: ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.startsWith("application/wasm")
    ? await WebAssembly.compileStreaming(response)
    : await WebAssembly.compile(await response.arrayBuffer());
}
