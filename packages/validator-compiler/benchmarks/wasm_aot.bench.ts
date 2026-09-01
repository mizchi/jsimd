import { compileSchema, type GeneratedBooleanModule } from "../src/mod.ts";

interface BooleanValidator {
  readonly is: (input: unknown) => boolean;
}

let sink = false;

for (const width of [8, 16, 32, 64, 128]) {
  const properties = Object.fromEntries(
    Array.from({ length: width }, (_, index) => [
      `value${index}`,
      { type: "number", minimum: index, maximum: index + 100 },
    ]),
  );
  const schema = {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
  const javascriptArtifact = compileSchema(schema, {
    backend: "javascript",
    target: "boolean",
  });
  const wasmArtifact = compileSchema(schema);
  const javascript = await importModule<GeneratedBooleanModule>(javascriptArtifact.code);
  const legacyJavascript = width >= 128
    ? await importModule<GeneratedBooleanModule>(legacyJavascriptAot(width))
    : undefined;
  const preanalyzed = await importModule<GeneratedBooleanModule>(preanalyzedJavascript(width));
  const factory = await importModule<{
    instantiate(source: Uint8Array | WebAssembly.Module): BooleanValidator;
  }>(wasmArtifact.code);
  const wasmModule = new WebAssembly.Module(
    wasmArtifact.files.wasm! as Uint8Array<ArrayBuffer>,
  );
  const wasm = factory.instantiate(wasmModule);
  const legacyFactory = await importModule<{
    instantiate(source: Uint8Array | WebAssembly.Module): BooleanValidator;
  }>(legacyWasmJavascript(width));
  const wasmLegacy = legacyFactory.instantiate(wasmModule);
  const valid = Object.fromEntries(
    Array.from({ length: width }, (_, index) => [`value${index}`, index + 50]),
  );
  const earlyInvalid = { ...valid, value0: -1 };
  const invalid = { ...valid, [`value${width - 1}`]: width + 101 };

  if (legacyJavascript !== undefined) {
    const reversedValid = Object.fromEntries(Object.entries(valid).reverse());
    const extra = { ...valid, extra: 1 };
    for (
      const [name, validator] of [
        ["JS AOT legacy unknown", legacyJavascript],
        ["JS AOT ordered unknown", javascript],
      ] as const
    ) {
      for (
        const [path, input] of [
          ["valid", valid],
          ["reversed valid", reversedValid],
          ["extra unknown", extra],
        ] as const
      ) {
        Deno.bench({ name, group: `${width} numeric fields / JS shape ${path}` }, () => {
          sink = validator.is(input);
        });
      }
    }
  }

  const validators: [string, BooleanValidator][] = [
    ["JavaScript AOT", javascript],
    ["Preanalyzed JS AOT", preanalyzed],
    ["Wasm SIMD legacy switch", wasmLegacy],
    ["Wasm SIMD AOT", wasm],
  ];
  for (const [name, validator] of validators) {
    Deno.bench({ name, group: `${width} numeric fields / valid` }, () => {
      sink = validator.is(valid);
    });
    Deno.bench({ name, group: `${width} numeric fields / early invalid` }, () => {
      sink = validator.is(earlyInvalid);
    });
    Deno.bench({ name, group: `${width} numeric fields / late invalid` }, () => {
      sink = validator.is(invalid);
    });
  }

  if (width >= 64) {
    const reversedValid = Object.fromEntries(Object.entries(valid).reverse());
    const sameCountUnknown = { ...valid };
    delete sameCountUnknown[`value${width - 1}`];
    (sameCountUnknown as Record<string, unknown>).extra = 1;
    for (
      const [name, validator] of [
        ["Wasm SIMD legacy switch", wasmLegacy],
        ["Wasm SIMD AOT", wasm],
      ] as const
    ) {
      Deno.bench({ name, group: `${width} numeric fields / reversed valid` }, () => {
        sink = validator.is(reversedValid);
      });
      Deno.bench({ name, group: `${width} numeric fields / same-count unknown` }, () => {
        sink = validator.is(sameCountUnknown);
      });
    }
  }
}

globalThis.addEventListener("unload", () => {
  if (sink) return;
});

async function importModule<Module>(code: string): Promise<Module> {
  return await import(
    `data:text/javascript,${encodeURIComponent(code)}#${crypto.randomUUID()}`
  ) as Module;
}

function preanalyzedJavascript(width: number): string {
  const names = Array.from({ length: width }, (_, index) => `value${index}`);
  const required = names.map((name) => `own(value,${JSON.stringify(name)})`).join("&&");
  const cases = names.map((name) => `case ${JSON.stringify(name)}:`).join("");
  const checks = names.map((name, index) => {
    const value = `value[${JSON.stringify(name)}]`;
    return `typeof ${value}==="number"&&Number.isFinite(${value})&&${value}>=${index}&&${value}<=${
      index + 100
    }`;
  }).join("&&");
  return `const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
export const is=value=>{if(value===null||typeof value!=="object"||Array.isArray(value))return false;const keys=Object.keys(value);for(const key of keys)switch(key){${cases}break;default:return false}if(keys.length!==${width}&&!(${required}))return false;return ${checks}};
`;
}

function legacyJavascriptAot(width: number): string {
  const names = Array.from({ length: width }, (_, index) => `value${index}`);
  const checks = names.map((name, index) =>
    `if(!own(value,${JSON.stringify(name)})||!c${index + 1}(value[${
      JSON.stringify(name)
    }]))return false;`
  ).join("");
  const children = names.map((_, index) =>
    `const c${
      index + 1
    }=value=>typeof value==="number"&&Number.isFinite(value)&&value>=${index}&&value<=${
      index + 100
    };`
  ).join("\n");
  const unknown = names.map((name) => `key!==${JSON.stringify(name)}`).join("&&");
  return `const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
function c0(value){if(value===null||typeof value!=="object"||Array.isArray(value))return false;${checks}for(const key of Object.keys(value))if(${unknown})return false;return true}
${children}
export const is=value=>c0(value);
`;
}

function legacyWasmJavascript(width: number): string {
  const names = Array.from({ length: width }, (_, index) => `value${index}`);
  const values = names.map((name) => `value[${JSON.stringify(name)}]`);
  const required = names.map((name) => `own(value,${JSON.stringify(name)})`).join("&&");
  const cases = names.map((name) => `case ${JSON.stringify(name)}:`).join("");
  const types = values.map((value) => `typeof ${value}==="number"`).join("&&");
  const preflight = width >= 64
    ? 'if(!(value["value0"]>=0&&value["value0"]<=100))return false;'
    : "";
  return `const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
export const instantiate=source=>{const module=source instanceof WebAssembly.Module?source:new WebAssembly.Module(source);const predicate=new WebAssembly.Instance(module).exports.is;const is=value=>{if(value===null||typeof value!=="object"||Array.isArray(value))return false;${preflight}const keys=Object.keys(value);for(const key of keys)switch(key){${cases}break;default:return false}if(keys.length!==${width}&&!(${required}))return false;if(!(${types}))return false;return predicate(${
    values.join(",")
  })!==0};return{is}};
`;
}
