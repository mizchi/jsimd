import { measureF32GemmRowTile } from "./gemm_tile_measure.ts";

const arguments_ = runtimeArguments();
const result = await measureF32GemmRowTile({
  rows: argumentInteger(arguments_, "rows"),
  inner: argumentInteger(arguments_, "inner"),
  columns: argumentInteger(arguments_, "columns"),
  rowTile: argumentRowTile(arguments_),
  warmups: argumentInteger(arguments_, "warmups"),
  samples: argumentInteger(arguments_, "samples"),
  operationsPerSample: argumentInteger(arguments_, "operations"),
});
console.log(JSON.stringify({
  ...result,
  runtime: runtimeIdentity(),
}));

function runtimeArguments(): readonly string[] {
  const deno = (globalThis as { Deno?: { args: readonly string[] } }).Deno;
  if (deno !== undefined) return deno.args;
  const process_ = (globalThis as { process?: { argv: readonly string[] } }).process;
  if (process_ !== undefined) return process_.argv.slice(2);
  throw new Error("command-line arguments are unavailable");
}

function runtimeIdentity(): Readonly<{ name: string; version: string }> {
  const deno = (globalThis as { Deno?: { version: { deno: string } } }).Deno;
  if (deno !== undefined) return { name: "deno", version: deno.version.deno };
  const process_ = (globalThis as { process?: { versions: { node: string } } }).process;
  if (process_ !== undefined) return { name: "node", version: process_.versions.node };
  return { name: "unknown", version: "unknown" };
}

function argumentInteger(arguments_: readonly string[], name: string): number {
  const prefix = `--${name}=`;
  const raw = arguments_.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`missing or invalid ${prefix}`);
  return value;
}

function argumentRowTile(arguments_: readonly string[]): 1 | 2 | 4 | 8 {
  const value = argumentInteger(arguments_, "row-tile");
  if (value === 1 || value === 2 || value === 4 || value === 8) return value;
  throw new Error("row-tile must be 1, 2, 4, or 8");
}
