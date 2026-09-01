import { toJsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";
import * as z from "zod";
import {
  compileSchema,
  compileSchemaAsync,
  type GeneratedValidatorModule,
  type GeneratedWasmBooleanFactory,
  UnsupportedSchemaError,
} from "./mod.ts";

Deno.test("compiles Zod Standard JSON Schema metadata without a runtime Zod import", async () => {
  const source = z.strictObject({
    name: z.string().min(1),
    age: z.number().int().min(0).max(130),
  });
  const artifact = compileSchema(source, { backend: "javascript" });
  if (artifact.code.includes("zod")) throw new Error("generated code retained Zod");
  const generated = await importArtifact(artifact.code);
  if (!generated.is({ name: "Ada", age: 36 })) throw new Error("valid Zod-authored value");
  if (generated.is({ name: "Ada", age: 36, extra: true })) {
    throw new Error("strict Zod-authored value");
  }
});

Deno.test("compiles a strict Zod numeric object to schema-specialized Wasm SIMD", async () => {
  const shape = Object.fromEntries(
    Array.from({ length: 8 }, (_, index) => [
      `value${index}`,
      z.number().min(index).max(index + 100),
    ]),
  ) as Record<string, z.ZodNumber>;
  const artifact = compileSchema(z.strictObject(shape));
  if (artifact.files.wasm === undefined) throw new Error("Zod Wasm compilation omitted binary");
  if (artifact.code.includes("zod")) throw new Error("generated Wasm glue retained Zod");
  const factory = await importArtifact(artifact.code) as unknown as GeneratedWasmBooleanFactory;
  const validator = factory.instantiate(artifact.files.wasm);
  const valid = Object.fromEntries(
    Array.from({ length: 8 }, (_, index) => [`value${index}`, index + 50]),
  );
  if (!validator.is(valid)) throw new Error("valid Zod-authored numeric object");
  if (validator.is({ ...valid, value7: 108 })) throw new Error("Zod-authored Wasm maximum");
});

Deno.test("compiles a Valibot Standard Schema through its official JSON Schema adapter", async () => {
  const source = v.strictObject({
    name: v.pipe(v.string(), v.minLength(1)),
    age: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(130)),
  });
  const artifact = await compileSchemaAsync(source, { backend: "javascript" });
  const generated = await importArtifact(artifact.code);
  if (!generated.is({ name: "Ada", age: 36 })) throw new Error("valid Valibot-authored value");
  if (generated.is({ name: "", age: 36 })) throw new Error("Valibot minimum length");
});

Deno.test("still accepts an explicit Valibot JSON Schema conversion", async () => {
  const artifact = compileSchema(toJsonSchema(v.string()), { backend: "javascript" });
  const generated = await importArtifact(artifact.code);
  if (!generated.is("valid")) throw new Error("explicit Valibot JSON Schema conversion");
});

Deno.test("rejects unsupported Zod and Valibot semantics instead of approximating them", async () => {
  const unsupported = [
    z.string().refine((value) => value === "accepted"),
    z.string().transform((value) => value.length),
    z.coerce.number(),
    z.string().default("fallback"),
    v.pipe(v.string(), v.check((value) => value === "accepted")),
    v.pipe(v.string(), v.transform((value) => value.length)),
    v.optional(v.string(), "fallback"),
  ];
  for (const source of unsupported) {
    let found: unknown;
    try {
      await compileSchemaAsync(source, { backend: "javascript" });
    } catch (error) {
      found = error;
    }
    if (!(found instanceof UnsupportedSchemaError)) {
      throw new Error(`unsupported schema was accepted: ${String(source)}`);
    }
  }
});

async function importArtifact(code: string): Promise<GeneratedValidatorModule> {
  return await import(`data:text/javascript,${encodeURIComponent(code)}#${crypto.randomUUID()}`);
}
