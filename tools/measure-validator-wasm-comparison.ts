import { compileSchema } from "../packages/validator-compiler/src/mod.ts";
import { numericObjectSchema } from "../packages/validator-compiler/benchmarks/_wasm_library_comparison.ts";

const width = 32;
const fixtureDirectory = new URL(
  "../packages/validator-compiler/fixtures/wasm-comparison/dist/",
  import.meta.url,
);
await Deno.mkdir(fixtureDirectory, { recursive: true });

const schema = numericObjectSchema(width);
const javascriptArtifact = compileSchema(schema, { backend: "javascript", target: "boolean" });
const wasmArtifact = compileSchema(schema);
const wasmBytes = wasmArtifact.files.wasm!;

await Promise.all([
  Deno.writeTextFile(new URL("jsimd-javascript-aot.ts", fixtureDirectory), javascriptArtifact.code),
  Deno.writeTextFile(new URL("jsimd-wasm-aot.ts", fixtureDirectory), wasmArtifact.code),
  Deno.writeFile(new URL("jsimd-wasm-aot.wasm", fixtureDirectory), wasmBytes),
  ...Object.entries(librarySources(width)).map(([name, source]) =>
    Deno.writeTextFile(new URL(`${name}.ts`, fixtureDirectory), source)
  ),
]);

interface SizeRow {
  readonly name: string;
  readonly javascript: number;
  readonly wasm: number;
  readonly gzipJavascript: number;
  readonly gzipWasm: number;
}

const entries = [
  ["jsimd JavaScript AOT", "jsimd-javascript-aot"],
  ["jsimd Wasm SIMD AOT", "jsimd-wasm-aot"],
  ["Zod compile", "zod"],
  ["Zod Mini compile", "zod-mini"],
  ["Valibot is", "valibot"],
  ["ArkType allows", "arktype"],
] as const;

const rows: SizeRow[] = [];
for (const [name, entry] of entries) {
  const input = new URL(`${entry}.ts`, fixtureDirectory);
  const output = new URL(`${entry}.bundle.js`, fixtureDirectory);
  const result = await new Deno.Command("pnpm", {
    args: [
      "exec",
      "esbuild",
      input.pathname,
      "--bundle",
      "--format=esm",
      "--minify",
      "--platform=browser",
      "--target=es2022",
      `--outfile=${output.pathname}`,
    ],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));

  const javascript = await Deno.readFile(output);
  const wasm = entry === "jsimd-wasm-aot" ? wasmBytes : new Uint8Array();
  rows.push({
    name,
    javascript: javascript.byteLength,
    wasm: wasm.byteLength,
    gzipJavascript: (await gzip(javascript)).byteLength,
    gzipWasm: (await gzip(wasm)).byteLength,
  });
}

console.log(`32-field strict numeric object, esbuild ${await esbuildVersion()}`);
console.log("| runtime | minified JS | Wasm | total | gzip JS | gzip Wasm | gzip total |");
console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const row of rows) {
  console.log(
    `| ${row.name} | ${format(row.javascript)} | ${format(row.wasm)} | ${
      format(row.javascript + row.wasm)
    } | ${format(row.gzipJavascript)} | ${format(row.gzipWasm)} | ${
      format(row.gzipJavascript + row.gzipWasm)
    } |`,
  );
}
console.log(
  `\njsimd Wasm declaration: ${
    format(new TextEncoder().encode(wasmArtifact.declaration).byteLength)
  }`,
);

function librarySources(fieldCount: number): Record<string, string> {
  return {
    zod: `import * as z from "zod";
const shape={};for(let i=0;i<${fieldCount};i++)shape["value"+i]=z.number().min(i).max(i+100);
const schema=z.compile(z.strictObject(shape),{strict:true});
export const validate=input=>schema.safeParse(input).success;
`,
    "zod-mini": `import * as z from "zod/mini";
const shape={};for(let i=0;i<${fieldCount};i++)shape["value"+i]=z.number().check(z.minimum(i),z.maximum(i+100));
const schema=z.compile(z.strictObject(shape),{strict:true});
export const validate=input=>z.safeParse(schema,input).success;
`,
    valibot: `import * as v from "valibot";
const shape={};for(let i=0;i<${fieldCount};i++)shape["value"+i]=v.pipe(v.number(),v.minValue(i),v.maxValue(i+100));
const schema=v.strictObject(shape);
export const validate=input=>v.is(schema,input);
`,
    arktype: `import {type} from "arktype";
const shape={};for(let i=0;i<${fieldCount};i++)shape["value"+i]=i+" <= number <= "+(i+100);
const schema=type(shape).onUndeclaredKey("reject");
export const validate=input=>schema.allows(input);
`,
  };
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.byteLength === 0) return bytes;
  return await new Response(
    new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")),
  ).bytes();
}

async function esbuildVersion(): Promise<string> {
  const result = await new Deno.Command("pnpm", {
    args: ["exec", "esbuild", "--version"],
    stdout: "piped",
  }).output();
  return new TextDecoder().decode(result.stdout).trim();
}

function format(bytes: number): string {
  return bytes === 0 ? "—" : `${(bytes / 1_000).toFixed(2)} kB`;
}
