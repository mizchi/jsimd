import type {
  CompiledArtifact,
  CompileSchemaOptions,
  LiteralValue,
  ObjectIR,
  SchemaIR,
} from "./types.ts";

const ORDERED_UNKNOWN_MIN_FIELDS = 128;

export function generateValidator(
  ir: SchemaIR,
  options: CompileSchemaOptions = {},
): CompiledArtifact {
  const booleanOnly = options.target === "boolean";
  const standard = options.target !== "boolean" && options.target !== "diagnostic";
  if (booleanOnly && options.jsonParser === "native") {
    throw new TypeError("boolean target cannot emit parseJSON");
  }
  if (booleanOnly && options.diagnosticMode === "single-pass") {
    throw new TypeError("boolean target cannot emit diagnostics");
  }
  const nodes: SchemaIR[] = [];
  const ids = new Map<SchemaIR, number>();
  collect(ir, nodes, ids);
  const needsOwn = nodes.some((node) => node.kind === "object");
  const needsCodePoints = nodes.some((node) =>
    node.kind === "string" && node.lengthUnit === "code_point" &&
    (node.minimumLength !== undefined || node.maximumLength !== undefined)
  );
  const lines = [
    ...(booleanOnly ? [] : ["const issue=(code,args,path)=>({code,args,path});"]),
    ...(standard
      ? [
        'const standardMessage=issue=>{const value=issue.args[0];switch(issue.code){case"type":return"Expected "+value;case"required":return"Expected required property";case"literal":return"Expected "+JSON.stringify(value);case"union":return"Expected union";case"integer":return"Expected integer";case"min_value":return"Expected >= "+value;case"max_value":return"Expected <= "+value;case"greater_than":return"Expected > "+value;case"less_than":return"Expected < "+value;case"min_length":return"Expected length >= "+value;case"max_length":return"Expected length <= "+value;case"unknown_key":return"Expected no additional properties";case"never":return"Expected no value";case"invalid_json":return"Invalid JSON"}};',
        "const standardIssue=issue=>({message:standardMessage(issue),path:issue.path});",
      ]
      : []),
    ...(needsOwn
      ? ["const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);"]
      : []),
    ...(needsCodePoints
      ? [
        "const codePoints=value=>/[\\uD800-\\uDFFF]/.test(value)?[...value].length:value.length;",
      ]
      : []),
  ];
  const checkIds = booleanOnly ? collectCheckIds(ir, ids) : undefined;
  for (let id = 0; id < nodes.length; id++) {
    if (checkIds === undefined || checkIds.has(id)) lines.push(checkFunction(id, nodes[id]!, ids));
  }
  if (!booleanOnly) {
    for (let id = 0; id < nodes.length; id++) lines.push(diagnoseFunction(id, nodes[id]!, ids));
  }
  const root = ids.get(ir)!;
  lines.push(`export const is=value=>c${root}(value);`);
  if (booleanOnly) {
    return artifact(`${lines.join("\n")}\n`, declaration(ir, options), ir);
  }
  lines.push(
    options.diagnosticMode === "single-pass"
      ? `export const validate=value=>{const found=d${root}(value,[]);return found===undefined?{value}:{issues:[found]}};`
      : `export const validate=value=>c${root}(value)?{value}:{issues:[d${root}(value,[])]};`,
  );
  if (options.jsonParser === "native") {
    lines.push(
      'export const parseJSON=text=>{if(typeof text!=="string")return{issues:[issue("type",["JSON string"],[])]};let value;try{value=JSON.parse(text)}catch{return{issues:[issue("invalid_json",[],[])]}}return validate(value)};',
    );
  }
  if (standard) {
    lines.push(
      "const standardValidate=value=>{const result=validate(value);return result.issues?{issues:[standardIssue(result.issues[0])]}:result};",
      'export const schema={"~standard":{version:1,vendor:"jsimd-validator/aot",validate:standardValidate}};',
      "export default schema;",
    );
  }
  return artifact(`${lines.join("\n")}\n`, declaration(ir, options), ir);
}

function artifact(code: string, declaration: string, ir: SchemaIR): CompiledArtifact {
  return {
    backend: "javascript",
    files: { javascript: code, typescript: declaration },
    code,
    declaration,
    ir,
  };
}

function collect(node: SchemaIR, nodes: SchemaIR[], ids: Map<SchemaIR, number>): number {
  const found = ids.get(node);
  if (found !== undefined) return found;
  const id = nodes.length;
  ids.set(node, id);
  nodes.push(node);
  if (node.kind === "array") collect(node.item, nodes, ids);
  if (node.kind === "object") { for (const field of node.fields) collect(field.node, nodes, ids); }
  if (node.kind === "union") { for (const option of node.options) collect(option, nodes, ids); }
  return id;
}

function collectCheckIds(node: SchemaIR, ids: Map<SchemaIR, number>, found = new Set<number>()) {
  const id = ids.get(node)!;
  if (found.has(id)) return found;
  found.add(id);
  if (node.kind === "array") collectCheckIds(node.item, ids, found);
  if (node.kind === "object") {
    for (const field of node.fields) collectCheckIds(field.node, ids, found);
  }
  if (node.kind === "union") {
    for (const option of node.options) {
      if (inlineCheck(option, "value") === undefined) collectCheckIds(option, ids, found);
    }
  }
  return found;
}

function checkFunction(id: number, node: SchemaIR, ids: Map<SchemaIR, number>): string {
  switch (node.kind) {
    case "any":
      return `const c${id}=value=>true;`;
    case "never":
      return `const c${id}=value=>false;`;
    case "string": {
      const length = node.lengthUnit === "code_point" ? "codePoints(value)" : "value.length";
      if (node.minimumLength === undefined && node.maximumLength === undefined) {
        return `const c${id}=value=>typeof value==="string";`;
      }
      const checks = [
        ...(node.minimumLength === undefined ? [] : [`length>=${node.minimumLength}`]),
        ...(node.maximumLength === undefined ? [] : [`length<=${node.maximumLength}`]),
      ];
      return `function c${id}(value){if(typeof value!=="string")return false;const length=${length};return ${
        checks.join("&&")
      }}`;
    }
    case "number": {
      const checks = [
        ...(node.integer
          ? ["Number.isInteger(value)"]
          : ['typeof value==="number"', "Number.isFinite(value)"]),
        ...(node.minimum === undefined
          ? []
          : [`value${node.exclusiveMinimum ? ">" : ">="}${number(node.minimum)}`]),
        ...(node.maximum === undefined
          ? []
          : [`value${node.exclusiveMaximum ? "<" : "<="}${number(node.maximum)}`]),
      ];
      return `const c${id}=value=>${checks.join("&&")};`;
    }
    case "boolean":
      return `const c${id}=value=>typeof value==="boolean";`;
    case "null":
      return `const c${id}=value=>value===null;`;
    case "literal":
      return `const c${id}=value=>Object.is(value,${literal(node.value)});`;
    case "array": {
      const item = ids.get(node.item)!;
      const lengthChecks = [
        ...(node.minimumLength === undefined ? [] : [`value.length<${node.minimumLength}`]),
        ...(node.maximumLength === undefined ? [] : [`value.length>${node.maximumLength}`]),
      ];
      const invalidLength = lengthChecks.length === 0 ? "" : `||${lengthChecks.join("||")}`;
      return `function c${id}(value){if(!Array.isArray(value)${invalidLength})return false;for(let index=0;index<value.length;index++)if(!c${item}(value[index]))return false;return true}`;
    }
    case "object":
      return objectCheck(id, node, ids);
    case "union":
      return `const c${id}=value=>${
        node.options.map((option) => inlineCheck(option, "value") ?? `c${ids.get(option)!}(value)`)
          .join("||")
      };`;
  }
}

function inlineCheck(node: SchemaIR, value: string): string | undefined {
  switch (node.kind) {
    case "any":
      return "true";
    case "never":
      return "false";
    case "string":
      return node.minimumLength === undefined && node.maximumLength === undefined
        ? `typeof ${value}==="string"`
        : undefined;
    case "number":
      return undefined;
    case "boolean":
      return `typeof ${value}==="boolean"`;
    case "null":
      return `${value}===null`;
    case "literal":
      return typeof node.value === "number"
        ? `Object.is(${value},${literal(node.value)})`
        : `${value}===${literal(node.value)}`;
    case "union": {
      const options = node.options.map((option) => inlineCheck(option, value));
      return options.every((option) => option !== undefined)
        ? options.map((option) => `(${option})`).join("||")
        : undefined;
    }
    case "array":
    case "object":
      return undefined;
  }
}

function objectCheck(id: number, node: ObjectIR, ids: Map<SchemaIR, number>): string {
  const checks = node.fields.map((field) => {
    const key = JSON.stringify(field.name);
    const child = `c${ids.get(field.node)!}(value[${key}])`;
    return field.optional
      ? `if(own(value,${key})&&!${child})return false;`
      : `if(!own(value,${key})||!${child})return false;`;
  });
  const orderedUnknown = usesOrderedUnknown(node);
  const unknown = node.unknownKeys === "reject"
    ? orderedUnknown
      ? `const keys=Object.keys(value);let keyIndex=0;if(keys.length===${node.fields.length})for(;keyIndex<${node.fields.length}&&keys[keyIndex]===expectedKeys${id}[keyIndex];keyIndex++);if(keyIndex!==${node.fields.length})for(const key of keys)if(!knownKeys${id}.has(key))return false;`
      : `for(const key of Object.keys(value))if(${
        node.fields.map((field) => `key!==${JSON.stringify(field.name)}`).join("&&") || "true"
      })return false;`
    : "";
  const shapeConstants = orderedUnknown
    ? `const expectedKeys${id}=${
      JSON.stringify(node.fields.map((field) => field.name))
    },knownKeys${id}=new Set(expectedKeys${id});\n`
    : "";
  return `${shapeConstants}function c${id}(value){if(value===null||typeof value!=="object"||Array.isArray(value))return false;${
    checks.join("")
  }${unknown}return true}`;
}

function usesOrderedUnknown(node: ObjectIR): boolean {
  return node.unknownKeys === "reject" && node.fields.length >= ORDERED_UNKNOWN_MIN_FIELDS;
}

function diagnoseFunction(id: number, node: SchemaIR, ids: Map<SchemaIR, number>): string {
  switch (node.kind) {
    case "any":
      return `const d${id}=()=>undefined;`;
    case "never":
      return `const d${id}=(value,path)=>issue("never",[],path);`;
    case "string": {
      const length = node.lengthUnit === "code_point" ? "codePoints(value)" : "value.length";
      return `function d${id}(value,path){if(typeof value!=="string")return issue("type",["string"],path);${
        node.minimumLength === undefined
          ? ""
          : `if(${length}<${node.minimumLength})return issue("min_length",[${node.minimumLength}],path);`
      }${
        node.maximumLength === undefined
          ? ""
          : `if(${length}>${node.maximumLength})return issue("max_length",[${node.maximumLength}],path);`
      }}`;
    }
    case "number":
      return `function d${id}(value,path){if(typeof value!=="number"||!Number.isFinite(value))return issue("type",["finite number"],path);${
        node.integer ? 'if(!Number.isInteger(value))return issue("integer",[],path);' : ""
      }${
        node.minimum === undefined
          ? ""
          : `if(!(value${node.exclusiveMinimum ? ">" : ">="}${
            number(node.minimum)
          }))return issue("${node.exclusiveMinimum ? "greater_than" : "min_value"}",[${
            number(node.minimum)
          }],path);`
      }${
        node.maximum === undefined
          ? ""
          : `if(!(value${node.exclusiveMaximum ? "<" : "<="}${
            number(node.maximum)
          }))return issue("${node.exclusiveMaximum ? "less_than" : "max_value"}",[${
            number(node.maximum)
          }],path);`
      }}`;
    case "boolean":
      return `const d${id}=(value,path)=>typeof value==="boolean"?undefined:issue("type",["boolean"],path);`;
    case "null":
      return `const d${id}=(value,path)=>value===null?undefined:issue("type",["null"],path);`;
    case "literal":
      return `const d${id}=(value,path)=>Object.is(value,${
        literal(node.value)
      })?undefined:issue("literal",[${literal(node.value)}],path);`;
    case "array": {
      const item = ids.get(node.item)!;
      return `function d${id}(value,path){if(!Array.isArray(value))return issue("type",["array"],path);${
        node.minimumLength === undefined
          ? ""
          : `if(value.length<${node.minimumLength})return issue("min_length",[${node.minimumLength}],path);`
      }${
        node.maximumLength === undefined
          ? ""
          : `if(value.length>${node.maximumLength})return issue("max_length",[${node.maximumLength}],path);`
      }for(let index=0;index<value.length;index++)if(!c${item}(value[index]))return d${item}(value[index],[...path,index])}`;
    }
    case "object":
      return objectDiagnose(id, node, ids);
    case "union":
      return `const d${id}=(value,path)=>c${id}(value)?undefined:issue("union",[],path);`;
  }
}

function objectDiagnose(id: number, node: ObjectIR, ids: Map<SchemaIR, number>): string {
  const checks = node.fields.map((field) => {
    const key = JSON.stringify(field.name);
    const child = ids.get(field.node)!;
    if (field.optional) {
      return `if(own(value,${key})&&!c${child}(value[${key}]))return d${child}(value[${key}],[...path,${key}]);`;
    }
    return `if(!own(value,${key}))return issue("required",[],[...path,${key}]);if(!c${child}(value[${key}]))return d${child}(value[${key}],[...path,${key}]);`;
  });
  const unknown = node.unknownKeys === "reject"
    ? usesOrderedUnknown(node)
      ? `for(const key of Object.keys(value))if(!knownKeys${id}.has(key))return issue("unknown_key",[],[...path,key]);`
      : `for(const key of Object.keys(value))if(${
        node.fields.map((field) => `key!==${JSON.stringify(field.name)}`).join("&&") || "true"
      })return issue("unknown_key",[],[...path,key]);`
    : "";
  return `function d${id}(value,path){if(value===null||typeof value!=="object"||Array.isArray(value))return issue("type",["object"],path);${
    checks.join("")
  }${unknown}}`;
}

function declaration(ir: SchemaIR, options: CompileSchemaOptions): string {
  const output = ir.kind === "object"
    ? `export interface Output ${objectType(ir)}\n`
    : `export type Output = ${typeOf(ir)};\n`;
  if (options.target === "boolean") {
    return `${output}export declare function is(input: unknown): input is Output;\n`;
  }
  const issueTypes = `export interface IssueArguments {
  readonly type: readonly [expected: string];
  readonly required: readonly [];
  readonly literal: readonly [expected: string | number | boolean | null];
  readonly union: readonly [];
  readonly integer: readonly [];
  readonly min_value: readonly [requirement: number];
  readonly max_value: readonly [requirement: number];
  readonly greater_than: readonly [requirement: number];
  readonly less_than: readonly [requirement: number];
  readonly min_length: readonly [requirement: number];
  readonly max_length: readonly [requirement: number];
  readonly unknown_key: readonly [];
  readonly never: readonly [];
  readonly invalid_json: readonly [];
}
export type IssueCode = keyof IssueArguments;
export type ValidationIssue<Code extends IssueCode = IssueCode> = Code extends IssueCode ? { readonly code: Code; readonly args: IssueArguments[Code]; readonly path: readonly (string | number)[] } : never;
export type ValidationResult = { readonly value: Output; readonly issues?: undefined } | { readonly issues: readonly [ValidationIssue] };
`;
  const standard = options.target !== "diagnostic";
  const standardTypes = standard
    ? "export interface StandardIssue { readonly message: string; readonly path: readonly (string | number)[]; }\nexport type StandardValidationResult = { readonly value: Output; readonly issues?: undefined } | { readonly issues: readonly [StandardIssue] };\n"
    : "";
  return `${output}${issueTypes}${standardTypes}export declare function is(input: unknown): input is Output;\nexport declare function validate(input: unknown): ValidationResult;\n${
    options.jsonParser === "native"
      ? "export declare function parseJSON(input: string): ValidationResult;\n"
      : ""
  }${
    standard
      ? 'export declare const schema: { readonly "~standard": { readonly version: 1; readonly vendor: "jsimd-validator/aot"; readonly validate: (input: unknown) => StandardValidationResult; readonly types?: { readonly input: unknown; readonly output: Output } } };\nexport default schema;\n'
      : ""
  }`;
}

function typeOf(node: SchemaIR): string {
  switch (node.kind) {
    case "any":
      return "unknown";
    case "never":
      return "never";
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "literal":
      return literal(node.value);
    case "array":
      return `readonly (${typeOf(node.item)})[]`;
    case "object":
      return objectType(node);
    case "union":
      return node.options.map(typeOf).join(" | ");
  }
}

function objectType(node: ObjectIR): string {
  const fields = node.fields.map((field) =>
    `readonly ${JSON.stringify(field.name)}${field.optional ? "?" : ""}: ${typeOf(field.node)};`
  );
  if (node.unknownKeys === "allow") fields.push("readonly [key: string]: unknown;");
  return `{ ${fields.join(" ")} }`;
}

function literal(value: LiteralValue): string {
  return value === null ? "null" : JSON.stringify(value);
}

function number(value: number): string {
  return Object.is(value, -0) ? "-0" : String(value);
}
