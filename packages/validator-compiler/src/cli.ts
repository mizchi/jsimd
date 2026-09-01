#!/usr/bin/env node
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileSchemaAsync, compileSchemasAsync } from "./mod.ts";
import { optimizeWasm } from "./wasm_opt.ts";

export interface CliOptions {
  readonly backend: "javascript" | "wasm";
  readonly source: string;
  readonly output: string;
  readonly jsonParser: false | "native";
  readonly diagnosticMode: "valid-first" | "single-pass";
  readonly target: "standard" | "diagnostic" | "boolean";
  readonly wasmOpt: boolean;
}

export async function runCli(args: readonly string[]): Promise<void> {
  const options = parseArgs(args);
  const loaded = await loadSource(options.source);
  const compileOptions = {
    backend: options.backend,
    jsonParser: options.jsonParser,
    diagnosticMode: options.diagnosticMode,
    target: options.target,
  } as const;
  const artifact = loaded.kind === "batch"
    ? await compileSchemasAsync(loaded.sources, compileOptions)
    : await compileSchemaAsync(loaded.source, compileOptions);
  const wasm = artifact.files.wasm === undefined
    ? undefined
    : options.wasmOpt
    ? await optimizeWasm(artifact.files.wasm)
    : artifact.files.wasm;
  const output = resolve(options.output);
  await mkdir(dirname(output), { recursive: true });
  const writes = [
    writeFile(`${output}.js`, artifact.files.javascript),
    writeFile(`${output}.d.ts`, artifact.files.typescript),
  ];
  if (wasm !== undefined) {
    writes.push(writeFile(`${output}.wasm`, wasm));
  }
  await Promise.all(writes);
  console.log(
    `Generated ${output}.js, ${output}.d.ts${
      artifact.files.wasm === undefined ? "" : `, and ${output}.wasm`
    }`,
  );
}

export function parseArgs(args: readonly string[]): CliOptions {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: jsimd-validator-compiler <module[#export]> --out <path> [--javascript] [--wasm-opt] [--boolean-only|--diagnostic-only] [--json-parser] [--single-pass-diagnostics]",
    );
    process.exitCode = 0;
    throw new HelpRequested();
  }
  let source: string | undefined;
  let output: string | undefined;
  let backend: "javascript" | "wasm" = "wasm";
  let jsonParser: false | "native" = false;
  let diagnosticMode: "valid-first" | "single-pass" = "valid-first";
  let target: "standard" | "diagnostic" | "boolean" | undefined;
  let targetExplicit = false;
  let wasmOpt = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--out" || argument === "-o") {
      output = args[++index];
      if (output === undefined) throw new TypeError(`${argument} requires a path`);
    } else if (argument === "--json-parser") {
      jsonParser = "native";
    } else if (argument === "--javascript") {
      backend = "javascript";
    } else if (argument === "--wasm-opt") {
      wasmOpt = true;
    } else if (argument === "--single-pass-diagnostics") {
      diagnosticMode = "single-pass";
    } else if (argument === "--boolean-only") {
      target = "boolean";
      targetExplicit = true;
    } else if (argument === "--diagnostic-only") {
      target = "diagnostic";
      targetExplicit = true;
    } else if (argument.startsWith("-")) {
      throw new TypeError(`unknown option: ${argument}`);
    } else if (source === undefined) {
      source = argument;
    } else {
      throw new TypeError(`unexpected argument: ${argument}`);
    }
  }
  if (source === undefined || output === undefined) {
    throw new TypeError("source module and --out are required");
  }
  if (backend === "wasm") {
    if (targetExplicit && target !== "boolean") {
      throw new TypeError("the Wasm backend supports only the boolean target");
    }
    if (jsonParser !== false || diagnosticMode !== "valid-first") {
      throw new TypeError("the Wasm backend does not support JSON parsing or diagnostics");
    }
    target = "boolean";
  } else {
    if (wasmOpt) throw new TypeError("--wasm-opt requires the Wasm backend");
    target ??= "standard";
  }
  return { backend, source, output, jsonParser, diagnosticMode, target, wasmOpt };
}

type LoadedSource =
  | { readonly kind: "single"; readonly source: unknown }
  | { readonly kind: "batch"; readonly sources: Readonly<Record<string, unknown>> };

async function loadSource(specifier: string): Promise<LoadedSource> {
  const hash = specifier.lastIndexOf("#");
  const modulePath = hash === -1 ? specifier : specifier.slice(0, hash);
  const exportName = hash === -1 ? "default" : specifier.slice(hash + 1);
  if (extname(modulePath) === ".json") {
    if (hash !== -1) throw new TypeError("JSON schema files do not support an export fragment");
    return {
      kind: "single",
      source: JSON.parse(await readFile(resolve(modulePath), "utf8")),
    };
  }
  const module = await import(pathToFileURL(resolve(modulePath)).href) as Record<string, unknown>;
  if (hash === -1) {
    if (Object.keys(module).length === 0) {
      throw new TypeError(`${modulePath} does not export any schemas`);
    }
    return { kind: "batch", sources: module };
  }
  if (exportName === "" || !Object.hasOwn(module, exportName)) {
    throw new TypeError(`${modulePath} does not export ${JSON.stringify(exportName)}`);
  }
  return { kind: "single", source: module[exportName] };
}

class HelpRequested extends Error {}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  try {
    await runCli(args);
  } catch (error) {
    if (error instanceof HelpRequested) return;
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

export async function isMainModule(
  moduleUrl: string,
  entrypoint: string | undefined,
): Promise<boolean> {
  if (entrypoint === undefined) return false;
  try {
    return await realpath(entrypoint) === await realpath(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (await isMainModule(import.meta.url, process.argv[1])) {
  await main();
}
