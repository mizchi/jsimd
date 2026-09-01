import type {
  CompiledArtifact,
  CompileSchemaOptions,
  NumberIR,
  ObjectIR,
  SchemaIR,
} from "./types.ts";

interface NumericLane {
  readonly node: NumberIR;
  readonly access: string;
  readonly depth: number;
  readonly index: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly lowerOpcode: number;
  readonly upperOpcode: number;
}

interface ObjectPlan {
  readonly kind: "object";
  readonly schema: ObjectIR;
  readonly lanes: readonly NumericLane[];
}

const F64X2_GT = 0x4a;
const F64X2_LE = 0x4b;
const F64X2_GE = 0x4c;
const F64X2_LT = 0x49;
const EARLY_PREFLIGHT_MIN_FIELDS = 64;
const ORDERED_SHAPE_MIN_FIELDS = 32;

export function generateWasmValidator(
  ir: SchemaIR,
  options: CompileSchemaOptions,
): CompiledArtifact {
  if (options.target !== "boolean") {
    throw new TypeError('Wasm backend currently requires target: "boolean"');
  }
  if (options.jsonParser === "native" || options.diagnosticMode === "single-pass") {
    throw new TypeError("Wasm backend does not support JSON parsing or diagnostics");
  }
  const plan = analyze(ir);
  const wasm = encodeModule(plan.lanes);
  const javascript = glue(plan);
  const typescript = declaration(plan);
  return {
    backend: "wasm",
    files: { javascript, typescript, wasm },
    code: javascript,
    declaration: typescript,
    ir,
  };
}

function analyze(ir: SchemaIR): ObjectPlan {
  if (ir.kind !== "object" || ir.unknownKeys !== "reject" || ir.fields.length > 256) {
    throw new TypeError("Wasm backend requires a strict object with at most 256 root fields");
  }
  assertSupportedNode(ir, "$schema");
  const numeric: { readonly node: NumberIR; readonly access: string; readonly depth: number }[] =
    [];
  collectStaticNumbers(ir, "value", 0, numeric);
  if (numeric.length < 8 || numeric.length > 256) {
    throw new TypeError("Wasm object backend requires 8 to 256 static numeric leaves");
  }
  return {
    kind: "object",
    schema: ir,
    lanes: analyzeNumbers(numeric),
  };
}

function assertSupportedNode(node: SchemaIR, path: string): void {
  if (node.kind === "number") return;
  if (node.kind === "string") {
    if (node.maximumLength === undefined) {
      throw new TypeError(`${path} must be a bounded-string field with maxLength`);
    }
    return;
  }
  if (node.kind === "array") {
    if (node.maximumLength === undefined) {
      throw new TypeError(`${path} must be a bounded array with maxItems`);
    }
    assertSupportedNode(node.item, `${path}[]`);
    return;
  }
  if (node.kind === "object") {
    if (node.unknownKeys !== "reject" || node.fields.some((field) => field.optional)) {
      throw new TypeError(`${path} must be a strict object with required fields`);
    }
    if (node.fields.length > 256) throw new TypeError(`${path} has more than 256 fields`);
    for (const field of node.fields) {
      assertSupportedNode(field.node, `${path}.${field.name}`);
    }
    return;
  }
  throw new TypeError(`${path} uses an unsupported Wasm field schema`);
}

function analyzeNumbers(
  nodes: readonly {
    readonly node: NumberIR;
    readonly access: string;
    readonly depth: number;
  }[],
): readonly NumericLane[] {
  return nodes.map(({ node, access, depth }, index) => {
    return {
      node,
      access,
      depth,
      index,
      minimum: node.minimum ?? -Number.MAX_VALUE,
      maximum: node.maximum ?? Number.MAX_VALUE,
      lowerOpcode: node.minimum !== undefined && node.exclusiveMinimum ? F64X2_GT : F64X2_GE,
      upperOpcode: node.maximum !== undefined && node.exclusiveMaximum ? F64X2_LT : F64X2_LE,
    };
  });
}

function collectStaticNumbers(
  node: SchemaIR,
  access: string,
  depth: number,
  output: { node: NumberIR; access: string; depth: number }[],
): void {
  if (node.kind === "number") {
    output.push({ node, access, depth });
    return;
  }
  if (node.kind === "object") {
    for (const field of node.fields) {
      collectStaticNumbers(
        field.node,
        `${access}[${JSON.stringify(field.name)}]`,
        depth + 1,
        output,
      );
    }
    return;
  }
  if (
    node.kind === "array" && node.minimumLength !== undefined &&
    node.minimumLength === node.maximumLength && node.maximumLength <= 256
  ) {
    for (let index = 0; index < node.maximumLength; index++) {
      collectStaticNumbers(node.item, `${access}[${index}]`, depth + 1, output);
    }
  }
}

function encodeModule(lanes: readonly NumericLane[]): Uint8Array<ArrayBuffer> {
  const parameters = lanes.map(() => 0x7c);
  const type = [0x60, ...u32(parameters.length), ...parameters, 0x01, 0x7f];
  const typeSection = section(0x01, vector([type]));
  const functionSection = section(0x03, vector([[0x00]]));
  const name = new TextEncoder().encode("is");
  const exportSection = section(
    0x07,
    vector([[...u32(name.length), ...name, 0x00, 0x00]]),
  );

  const groups = Map.groupBy(
    lanes,
    (lane) => `${lane.lowerOpcode}:${lane.upperOpcode}`,
  );
  const instructions: number[] = [];
  let resultCount = 0;
  for (const group of groups.values()) {
    for (let index = 0; index < group.length; index += 2) {
      const left = group[index]!;
      const right = group[index + 1] ?? left;
      emitPair(instructions, left, right, lanes.length);
      if (resultCount++ > 0) instructions.push(0x71); // i32.and
    }
  }
  instructions.push(0x0b);
  const body = [0x01, 0x01, 0x7b, ...instructions]; // one reusable v128 local
  const codeSection = section(0x0a, vector([[...u32(body.length), ...body]]));
  return new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...typeSection,
    ...functionSection,
    ...exportSection,
    ...codeSection,
  ]);
}

function emitPair(
  output: number[],
  left: NumericLane,
  right: NumericLane,
  vectorLocal: number,
): void {
  emitValues(output, left.index, right.index);
  output.push(0x22, ...u32(vectorLocal)); // local.tee
  emitVectorConstant(output, left.minimum, right.minimum);
  simd(output, left.lowerOpcode);
  output.push(0x20, ...u32(vectorLocal)); // local.get
  emitVectorConstant(output, left.maximum, right.maximum);
  simd(output, left.upperOpcode);
  simd(output, 0x4e); // v128.and
  simd(output, 0xc3); // i64x2.all_true
}

function emitValues(output: number[], left: number, right: number): void {
  output.push(0x20, ...u32(left)); // local.get
  simd(output, 0x14); // f64x2.splat
  output.push(0x20, ...u32(right));
  simd(output, 0x22); // f64x2.replace_lane
  output.push(0x01);
}

function emitVectorConstant(output: number[], left: number, right: number): void {
  simd(output, 0x0c); // v128.const
  output.push(...f64(left), ...f64(right));
}

function simd(output: number[], opcode: number): void {
  output.push(0xfd, ...u32(opcode));
}

function glue(plan: ObjectPlan): string {
  const fields = plan.schema.fields;
  const fieldNames = fields.map((field) => field.name);
  const values = fields.map((field) => `value[${JSON.stringify(field.name)}]`);
  const numericValues = plan.lanes.map((lane) => lane.access);
  const first = plan.lanes.find((lane) => lane.depth === 1);
  const firstValue = first?.access;
  const lower = first?.node.minimum !== undefined && first.node.exclusiveMinimum ? ">" : ">=";
  const upper = first?.node.maximum !== undefined && first.node.exclusiveMaximum ? "<" : "<=";
  const firstInteger = first?.node.integer ? `||!Number.isInteger(${firstValue})` : "";
  // One scalar guard amortizes at this width and avoids the dominant strict-shape scan on failure.
  const preflight = fields.length >= EARLY_PREFLIGHT_MIN_FIELDS && first !== undefined
    ? `if(typeof ${firstValue}!=="number"${firstInteger}||!(${firstValue}${lower}${first.minimum}&&${firstValue}${upper}${first.maximum}))return false;`
    : "";
  const required = fields.map((field) => `own(value,${JSON.stringify(field.name)})`).join("&&");
  const types = values.map((value, index) => fieldPredicate(value, fields[index]!.node, true)).join(
    "&&",
  );
  const orderedShape = fields.length >= ORDERED_SHAPE_MIN_FIELDS;
  const shape = orderedShape
    ? `const keys=Object.keys(value);let keyIndex=0;if(keys.length===${fields.length})for(;keyIndex<${fields.length}&&keys[keyIndex]===expected[keyIndex];keyIndex++);if(keyIndex!==${fields.length}){for(const key of keys)if(!known.has(key))return false;if(keys.length!==${fields.length}&&!(${required}))return false}`
    : `const keys=Object.keys(value);for(const key of keys)switch(key){${
      fields.map((field) => `case ${JSON.stringify(field.name)}:`).join("")
    }break;default:return false}if(keys.length!==${fields.length}&&!(${required}))return false;`;
  const shapeConstants = orderedShape
    ? `const expected=${
      JSON.stringify(fieldNames)
    },known=new Set(expected),own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);`
    : `const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);`;
  return `${shapeConstants}
export const instantiate=source=>{const module=source instanceof WebAssembly.Module?source:new WebAssembly.Module(source);const predicate=new WebAssembly.Instance(module).exports.is;const is=value=>{if(value===null||typeof value!=="object"||Array.isArray(value))return false;${preflight}${shape}if(!(${types}))return false;return predicate(${
    numericValues.join(",")
  })!==0};return{is}};
`;
}

function fieldPredicate(value: string, node: SchemaIR, flattenStatic: boolean): string {
  if (node.kind === "number") {
    const type = node.integer
      ? `Number.isInteger(${value})`
      : `typeof ${value}==="number"${flattenStatic ? "" : `&&Number.isFinite(${value})`}`;
    if (flattenStatic) return type;
    const minimum = node.minimum === undefined
      ? ""
      : `&&${value}${node.exclusiveMinimum ? ">" : ">="}${node.minimum}`;
    const maximum = node.maximum === undefined
      ? ""
      : `&&${value}${node.exclusiveMaximum ? "<" : "<="}${node.maximum}`;
    return `${type}${minimum}${maximum}`;
  }
  if (node.kind === "string") {
    const length = node.lengthUnit === "code_point"
      ? `(/[\\uD800-\\uDFFF]/.test(${value})?[...${value}].length:${value}.length)`
      : `${value}.length`;
    const minimum = node.minimumLength === undefined ? "" : `&&${length}>=${node.minimumLength}`;
    const maximum = node.maximumLength === undefined ? "" : `&&${length}<=${node.maximumLength}`;
    return `typeof ${value}==="string"${minimum}${maximum}`;
  }
  if (node.kind === "array") {
    const minimum = node.minimumLength === undefined
      ? ""
      : `&&${value}.length>=${node.minimumLength}`;
    const maximum = node.maximumLength === undefined
      ? ""
      : `&&${value}.length<=${node.maximumLength}`;
    const fixed = flattenStatic && node.minimumLength !== undefined &&
      node.minimumLength === node.maximumLength && node.maximumLength <= 256;
    const items = fixed
      ? Array.from(
        { length: node.maximumLength! },
        (_, index) => `&&(${fieldPredicate(`${value}[${index}]`, node.item, true)})`,
      ).join("")
      : `&&${value}.every(item=>${fieldPredicate("item", node.item, false)})`;
    return `Array.isArray(${value})${minimum}${maximum}${items}`;
  }
  if (node.kind === "object") {
    const names = node.fields.map((field) => field.name);
    const known = names.length === 0
      ? `Object.keys(${value}).length===0`
      : `Object.keys(${value}).every(key=>${
        names.map((name) => `key===${JSON.stringify(name)}`).join("||")
      })`;
    const required = node.fields.map((field) => `own(${value},${JSON.stringify(field.name)})`).join(
      "&&",
    );
    const children = node.fields.map((field) =>
      fieldPredicate(`${value}[${JSON.stringify(field.name)}]`, field.node, flattenStatic)
    ).join("&&");
    return `${value}!==null&&typeof ${value}==="object"&&!Array.isArray(${value})&&${known}${
      required === "" ? "" : `&&${required}`
    }${children === "" ? "" : `&&${children}`}`;
  }
  throw new TypeError("unsupported Wasm object field");
}

function declaration(plan: ObjectPlan): string {
  return `export type Output = ${objectOutput(plan.schema)};
export interface WasmBooleanValidator { readonly is: (input: unknown) => input is Output; }
export declare function instantiate(source: ArrayBuffer | Uint8Array | WebAssembly.Module): WasmBooleanValidator;
`;
}

function objectOutput(object: ObjectIR): string {
  const properties = object.fields.map((field) =>
    `readonly ${JSON.stringify(field.name)}: ${wasmTypeOf(field.node)};`
  ).join(" ");
  const index = object.unknownKeys === "allow" ? " readonly [key: string]: unknown;" : "";
  return `{ ${properties}${index} }`;
}

function wasmTypeOf(node: SchemaIR): string {
  if (node.kind === "number") return "number";
  if (node.kind === "string") return "string";
  if (node.kind === "array") return `readonly (${wasmTypeOf(node.item)})[]`;
  if (node.kind === "object") return objectOutput(node);
  throw new TypeError("unsupported Wasm declaration field");
}

function section(id: number, payload: readonly number[]): number[] {
  return [id, ...u32(payload.length), ...payload];
}

function vector(entries: readonly (readonly number[])[]): number[] {
  return [...u32(entries.length), ...entries.flat()];
}

function u32(value: number): number[] {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return bytes;
}

function f64(value: number): number[] {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat64(0, value, true);
  return [...new Uint8Array(buffer)];
}
