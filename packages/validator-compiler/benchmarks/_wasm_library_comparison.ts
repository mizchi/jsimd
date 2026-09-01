import { type } from "arktype";
import * as v from "valibot";
import * as z from "zod";
import * as zm from "zod/mini";
import { compileSchema, type GeneratedBooleanModule } from "../src/mod.ts";

export interface ComparisonValidator {
  readonly name: string;
  readonly check: (input: unknown) => boolean;
}

export interface StrictNumericComparison {
  readonly width: number;
  readonly valid: Record<string, number>;
  readonly lowerBounds: Record<string, number>;
  readonly upperBounds: Record<string, number>;
  readonly earlyInvalid: Record<string, number>;
  readonly lateInvalid: Record<string, number>;
  readonly validators: readonly ComparisonValidator[];
  readonly wasmBytes: Uint8Array<ArrayBuffer>;
  readonly wasmModule: WebAssembly.Module;
  readonly instantiateWasm: (
    source: Uint8Array<ArrayBuffer> | WebAssembly.Module,
  ) => GeneratedBooleanModule;
}

export function numericObjectSchema(width: number, offset = 0) {
  const properties = Object.fromEntries(
    Array.from({ length: width }, (_, index) => [
      `value${index}`,
      {
        type: "number" as const,
        minimum: offset + index,
        maximum: offset + index + 100,
      },
    ]),
  );
  return {
    type: "object" as const,
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

export async function strictNumericComparison(width: number): Promise<StrictNumericComparison> {
  const names = Array.from({ length: width }, (_, index) => `value${index}`);
  const jsonSchema = numericObjectSchema(width);
  const javascriptArtifact = compileSchema(jsonSchema, {
    backend: "javascript",
    target: "boolean",
  });
  const wasmArtifact = compileSchema(jsonSchema);
  const javascript = await importGenerated<GeneratedBooleanModule>(javascriptArtifact.code);
  const wasmFactory = await importGenerated<{
    instantiate(source: Uint8Array<ArrayBuffer> | WebAssembly.Module): GeneratedBooleanModule;
  }>(wasmArtifact.code);
  const wasmBytes = wasmArtifact.files.wasm! as Uint8Array<ArrayBuffer>;
  const wasmModule = new WebAssembly.Module(wasmBytes);
  const wasm = wasmFactory.instantiate(wasmModule);

  const zodShape: Record<string, z.ZodNumber> = {};
  const zodMiniShape: Record<string, zm.ZodMiniNumber> = {};
  const valibotShape: Record<string, v.GenericSchema> = {};
  const arkShape: Record<string, string> = {};
  for (let index = 0; index < width; index++) {
    zodShape[`value${index}`] = z.number().min(index).max(index + 100);
    zodMiniShape[`value${index}`] = zm.number().check(
      zm.minimum(index),
      zm.maximum(index + 100),
    );
    valibotShape[`value${index}`] = v.pipe(
      v.number(),
      v.minValue(index),
      v.maxValue(index + 100),
    );
    arkShape[`value${index}`] = `${index} <= number <= ${index + 100}`;
  }

  const zod = z.compile(z.strictObject(zodShape), { strict: true });
  const zodMini = zm.compile(zm.strictObject(zodMiniShape), { strict: true });
  const valibot = v.strictObject(valibotShape);
  const arktype = type(arkShape).onUndeclaredKey("reject");

  const lowerBounds = Object.fromEntries(names.map((name, index) => [name, index]));
  const upperBounds = Object.fromEntries(names.map((name, index) => [name, index + 100]));
  const valid = Object.fromEntries(names.map((name, index) => [name, index + 50]));

  return {
    width,
    valid,
    lowerBounds,
    upperBounds,
    earlyInvalid: { ...valid, value0: -1 },
    lateInvalid: { ...valid, [`value${width - 1}`]: width + 100 },
    wasmBytes,
    wasmModule,
    instantiateWasm: wasmFactory.instantiate,
    validators: [
      { name: "jsimd JavaScript AOT", check: javascript.is },
      { name: "jsimd Wasm SIMD AOT", check: wasm.is },
      { name: "Zod compile", check: (input) => zod.safeParse(input).success },
      { name: "Zod Mini compile", check: (input) => zm.safeParse(zodMini, input).success },
      { name: "Valibot is", check: (input) => v.is(valibot, input) },
      { name: "ArkType allows", check: (input) => arktype.allows(input) },
    ],
  };
}

async function importGenerated<Module>(code: string): Promise<Module> {
  return await import(
    `data:text/javascript,${encodeURIComponent(code)}#${crypto.randomUUID()}`
  ) as Module;
}
