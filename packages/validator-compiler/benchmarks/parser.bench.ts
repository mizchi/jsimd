import * as v from "valibot";
import * as z from "zod";
import { compileSchema, type GeneratedValidatorModule } from "../src/mod.ts";

const zodItem = z.strictObject({
  name: z.string().min(1).max(16),
  age: z.number().int().min(0).max(130),
  active: z.boolean(),
  tags: z.array(z.string()).max(4),
});
const valibotItem = v.strictObject({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(16)),
  age: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(130)),
  active: v.boolean(),
  tags: v.pipe(v.array(v.string()), v.maxLength(4)),
});

const item = { name: "Ada", age: 36, active: true, tags: ["compiler"] };
const workloads = [
  { name: "single object", zod: zodItem, valibot: valibotItem, value: item },
  {
    name: "128 objects",
    zod: z.array(zodItem),
    valibot: v.array(valibotItem),
    value: Array.from({ length: 128 }, (_, index) => ({ ...item, age: index % 131 })),
  },
] as const;

let sink: unknown;

for (const workload of workloads) {
  const text = JSON.stringify(workload.value);
  const artifact = compileSchema(workload.zod, {
    backend: "javascript",
    jsonParser: "native",
  });
  const aot = await importArtifact(artifact.code);
  const zod = z.compile(workload.zod, { strict: true });

  const parsed = JSON.parse(text);
  if (!aot.is(parsed) || !zod.safeParse(parsed).success || !v.is(workload.valibot, parsed)) {
    throw new Error(`${workload.name}: benchmark schemas disagree`);
  }

  Deno.bench({ name: "JSON.parse only", group: workload.name, baseline: true }, () => {
    sink = JSON.parse(text);
  });
  Deno.bench({ name: "AOT parseJSON", group: workload.name }, () => {
    sink = aot.parseJSON!(text);
  });
  Deno.bench({ name: "JSON.parse + AOT is", group: workload.name }, () => {
    sink = aot.is(JSON.parse(text));
  });
  Deno.bench({ name: "JSON.parse + zod.compile", group: workload.name }, () => {
    sink = zod.safeParse(JSON.parse(text));
  });
  Deno.bench({ name: "JSON.parse + valibot is", group: workload.name }, () => {
    sink = v.is(workload.valibot, JSON.parse(text));
  });
}

async function importArtifact(code: string): Promise<GeneratedValidatorModule> {
  return await import(`data:text/javascript,${encodeURIComponent(code)}#${crypto.randomUUID()}`);
}

globalThis.addEventListener("unload", () => {
  if (sink === Symbol.for("never")) console.log(sink);
});
