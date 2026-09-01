const packageDirectory = new URL("../packages/validator-compiler/", import.meta.url);
const packageMetadata = JSON.parse(
  await Deno.readTextFile(new URL("package.json", packageDirectory)),
) as {
  name: string;
  version: string;
  exports: Record<string, string>;
  bin: Record<string, string>;
};
const denoMetadata = JSON.parse(
  await Deno.readTextFile(new URL("deno.json", packageDirectory)),
) as { name: string; version: string; exports: string };

if (
  packageMetadata.name !== denoMetadata.name || packageMetadata.version !== denoMetadata.version ||
  JSON.stringify(Object.keys(packageMetadata.exports)) !== JSON.stringify(["."]) ||
  JSON.stringify(packageMetadata.bin) !==
    JSON.stringify({ "jsimd-validator-compiler": "./bin/jsimd-validator-compiler.js" }) ||
  denoMetadata.exports !== "./src/mod.ts"
) throw new Error("validator compiler package.json and deno.json release metadata differ");

const { compileSchema } = await import("../packages/validator-compiler/dist/mod.js");
const artifact = compileSchema({ type: "string", minLength: 1 }, { backend: "javascript" });
if (artifact.files.javascript.includes("import ")) {
  throw new Error("AOT artifact retained a runtime import");
}
if (
  artifact.files.javascript !== artifact.code ||
  artifact.files.typescript !== artifact.declaration
) throw new Error("AOT artifact did not return paired JavaScript and TypeScript files");
const temporaryDirectory = await Deno.makeTempDir({
  dir: packageDirectory.pathname,
  prefix: ".smoke-",
});
try {
  const output = `${temporaryDirectory}/user`;
  const cli = await new Deno.Command("node", {
    args: [
      new URL("dist/cli.js", packageDirectory).pathname,
      new URL("fixtures/schema.mjs", packageDirectory).pathname + "#User",
      "--out",
      output,
      "--javascript",
      "--json-parser",
      "--single-pass-diagnostics",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!cli.success) throw new Error(new TextDecoder().decode(cli.stderr));
  const generated = await import(`${pathToFileUrl(output + ".js")}?smoke=${crypto.randomUUID()}`);
  if (!generated.is({ name: "Ada", age: 36 })) {
    throw new Error("generated compiler fixture rejected valid input");
  }
  if (generated.is({ name: "Ada", age: 131 })) {
    throw new Error("generated compiler fixture accepted invalid input");
  }
  if (!generated.parseJSON('{"name":"Ada","age":36}').value) {
    throw new Error("generated JSON parser failed");
  }
  const declaration = await Deno.readTextFile(`${output}.d.ts`);
  if (!declaration.includes("export interface Output")) {
    throw new Error("generated declaration is missing Output");
  }
  const booleanOutput = `${temporaryDirectory}/user-is`;
  const booleanCli = await new Deno.Command("node", {
    args: [
      new URL("dist/cli.js", packageDirectory).pathname,
      new URL("fixtures/schema.mjs", packageDirectory).pathname + "#User",
      "--out",
      booleanOutput,
      "--javascript",
      "--boolean-only",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!booleanCli.success) throw new Error(new TextDecoder().decode(booleanCli.stderr));
  const generatedBoolean = await import(
    `${pathToFileUrl(booleanOutput + ".js")}?smoke=${crypto.randomUUID()}`
  );
  if (!generatedBoolean.is({ name: "Ada", age: 36 }) || "validate" in generatedBoolean) {
    throw new Error("generated boolean-only module has the wrong exports");
  }
  const booleanDeclaration = await Deno.readTextFile(`${booleanOutput}.d.ts`);
  if (booleanDeclaration.includes("validate")) {
    throw new Error("generated boolean-only declaration retained validate");
  }
  const diagnosticOutput = `${temporaryDirectory}/user-diagnostic`;
  const diagnosticCli = await new Deno.Command("node", {
    args: [
      new URL("dist/cli.js", packageDirectory).pathname,
      new URL("fixtures/schema.mjs", packageDirectory).pathname + "#User",
      "--out",
      diagnosticOutput,
      "--javascript",
      "--diagnostic-only",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!diagnosticCli.success) throw new Error(new TextDecoder().decode(diagnosticCli.stderr));
  const generatedDiagnostic = await import(
    `${pathToFileUrl(diagnosticOutput + ".js")}?smoke=${crypto.randomUUID()}`
  );
  const diagnosticResult = generatedDiagnostic.validate({ name: "Ada", age: 131 });
  if (
    !("issues" in diagnosticResult) || diagnosticResult.issues[0].code !== "max_value" ||
    diagnosticResult.issues[0].args[0] !== 130 || "schema" in generatedDiagnostic
  ) {
    throw new Error("generated diagnostic-only module has the wrong issue contract");
  }
  const diagnosticDeclaration = await Deno.readTextFile(`${diagnosticOutput}.d.ts`);
  if (diagnosticDeclaration.includes("StandardValidationResult")) {
    throw new Error("generated diagnostic-only declaration retained the formatting adapter");
  }
  const wasmOutput = `${temporaryDirectory}/wide-metrics`;
  const wasmCli = await new Deno.Command("node", {
    args: [
      new URL("dist/cli.js", packageDirectory).pathname,
      new URL("fixtures/schema.mjs", packageDirectory).pathname + "#WideMetrics",
      "--out",
      wasmOutput,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!wasmCli.success) throw new Error(new TextDecoder().decode(wasmCli.stderr));
  const wasmBytes = await Deno.readFile(`${wasmOutput}.wasm`);
  if (!WebAssembly.validate(wasmBytes as Uint8Array<ArrayBuffer>)) {
    throw new Error("CLI generated an invalid Wasm module");
  }
  const generatedWasm = await import(
    `${pathToFileUrl(wasmOutput + ".js")}?smoke=${crypto.randomUUID()}`
  );
  const wasmValidator = generatedWasm.instantiate(wasmBytes);
  const validMetrics = Object.fromEntries(
    Array.from({ length: 32 }, (_, index) => [`value${index}`, index + 50]),
  );
  if (!wasmValidator.is(validMetrics) || wasmValidator.is({ ...validMetrics, value31: 132 })) {
    throw new Error("generated Wasm validator has the wrong semantics");
  }
  const wasmDeclaration = await Deno.readTextFile(`${wasmOutput}.d.ts`);
  if (!wasmDeclaration.includes("WasmBooleanValidator")) {
    throw new Error("generated Wasm declaration is missing its instantiation contract");
  }
  const batchOutput = `${temporaryDirectory}/batch`;
  const pathSeparator = Deno.build.os === "windows" ? ";" : ":";
  const binaryDirectory = new URL("../node_modules/.bin/", import.meta.url).pathname;
  const batchCli = await new Deno.Command("node", {
    args: [
      new URL("dist/cli.js", packageDirectory).pathname,
      new URL("fixtures/batch-schemas.mjs", packageDirectory).pathname,
      "--out",
      batchOutput,
      "--wasm-opt",
    ],
    env: {
      PATH: `${binaryDirectory}${pathSeparator}${Deno.env.get("PATH") ?? ""}`,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!batchCli.success) throw new Error(new TextDecoder().decode(batchCli.stderr));
  const batchWasm = await Deno.readFile(`${batchOutput}.wasm`);
  if (!WebAssembly.validate(batchWasm as Uint8Array<ArrayBuffer>)) {
    throw new Error("batch CLI generated invalid optimized Wasm");
  }
  const batchFactory = await import(
    `${pathToFileUrl(batchOutput + ".js")}?smoke=${crypto.randomUUID()}`
  );
  const batch = batchFactory.instantiate(batchWasm);
  const packet = Object.fromEntries(
    Array.from({ length: 32 }, (_, index) => [`value${index}`, index + 50]),
  );
  const telemetry = Object.fromEntries(
    Array.from({ length: 32 }, (_, index) => [`value${index}`, index + 150]),
  );
  if (
    !batch.Packet.is(packet) || !batch.Telemetry.is(telemetry) ||
    batch.Telemetry.is({ ...telemetry, value0: 99 })
  ) {
    throw new Error("batch CLI generated validators with the wrong semantics");
  }
  const batchDeclaration = await Deno.readTextFile(`${batchOutput}.d.ts`);
  for (
    const expected of ["export interface Outputs", "export type Packet", "export type Telemetry"]
  ) {
    if (!batchDeclaration.includes(expected)) {
      throw new Error(`batch declaration is missing ${expected}`);
    }
  }
  for (const exportName of ["ZodUser", "ValibotUser"]) {
    const standardOutput = `${temporaryDirectory}/${exportName.toLowerCase()}`;
    const standardCli = await new Deno.Command("node", {
      args: [
        new URL("dist/cli.js", packageDirectory).pathname,
        new URL("fixtures/standard-schemas.mjs", packageDirectory).pathname + `#${exportName}`,
        "--out",
        standardOutput,
        "--javascript",
        "--boolean-only",
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!standardCli.success) throw new Error(new TextDecoder().decode(standardCli.stderr));
    const standardGenerated = await import(
      `${pathToFileUrl(standardOutput + ".js")}?smoke=${crypto.randomUUID()}`
    );
    if (
      !standardGenerated.is({ name: "Ada", age: 36 }) ||
      standardGenerated.is({ name: "Ada", age: 131 })
    ) {
      throw new Error(`${exportName} CLI generation has the wrong semantics`);
    }
  }
  await Deno.writeTextFile(
    `${temporaryDirectory}/consumer.ts`,
    'import type { StandardSchemaV1 } from "@standard-schema/spec";\n' +
      'import schema, { type Output } from "./user.js";\n' +
      'import type { Packet, Telemetry } from "./batch.js";\n' +
      "const compatible: StandardSchemaV1<unknown, Output> = schema;\n" +
      "const packet = {} as Packet;\n" +
      "const telemetry = {} as Telemetry;\n" +
      "void compatible; void packet; void telemetry;\n",
  );
  const typecheck = await new Deno.Command("pnpm", {
    args: [
      "exec",
      "tsc",
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ESNext",
      `${temporaryDirectory}/consumer.ts`,
    ],
    cwd: packageDirectory,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!typecheck.success) throw new Error(new TextDecoder().decode(typecheck.stdout));
} finally {
  await Deno.remove(temporaryDirectory, { recursive: true });
}

const packed = await new Deno.Command("npm", {
  args: ["pack", "--json", "--dry-run", "--ignore-scripts"],
  cwd: packageDirectory,
  stdout: "piped",
  stderr: "piped",
}).output();
if (!packed.success) throw new Error(new TextDecoder().decode(packed.stderr));

const [{ files, size, unpackedSize }] = JSON.parse(new TextDecoder().decode(packed.stdout)) as [{
  files: Array<{ path: string }>;
  size: number;
  unpackedSize: number;
}];
const paths = new Set(files.map((file) => file.path));
for (
  const required of [
    "bin/jsimd-validator-compiler.js",
    "dist/cli.d.ts",
    "dist/cli.js",
    "dist/generate.d.ts",
    "dist/generate.js",
    "dist/generate_wasm.d.ts",
    "dist/generate_wasm.js",
    "dist/mod.d.ts",
    "dist/mod.js",
    "dist/normalize.d.ts",
    "dist/normalize.js",
    "dist/types.d.ts",
    "dist/types.js",
    "dist/wasm_opt.d.ts",
    "dist/wasm_opt.js",
    "docs/backends.md",
    "docs/performance.md",
    "docs/schema-support.md",
    "LICENSE",
    "README.md",
  ]
) {
  if (!paths.has(required)) throw new Error(`validator compiler package is missing ${required}`);
}
for (const path of paths) {
  if (path.includes("json_parser")) {
    throw new Error(`validator compiler package retained abandoned JSON parser code: ${path}`);
  }
  if (path.includes("_test.")) {
    throw new Error(`validator compiler package includes a test file: ${path}`);
  }
}

const installDirectory = await Deno.makeTempDir({ prefix: "jsimd-validator-compiler-pack-" });
try {
  await Deno.writeTextFile(
    `${installDirectory}/package.json`,
    JSON.stringify({ private: true, type: "module" }),
  );
  const packedTarball = await new Deno.Command("npm", {
    args: [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      installDirectory,
    ],
    cwd: packageDirectory,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!packedTarball.success) throw new Error(new TextDecoder().decode(packedTarball.stderr));
  const [{ filename }] = JSON.parse(new TextDecoder().decode(packedTarball.stdout)) as [{
    filename: string;
  }];
  const tarball = `${installDirectory}/${filename}`;
  const installed = await new Deno.Command("npm", {
    args: [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      tarball,
    ],
    cwd: installDirectory,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!installed.success) throw new Error(new TextDecoder().decode(installed.stderr));

  const programmaticConsumer = await new Deno.Command("node", {
    args: [
      "--input-type=module",
      "--eval",
      `import { array, compileSchema, strictObject, string, u8 } from "@mizchi/jsimd-validator-compiler";
const properties = Object.fromEntries(Array.from({length: 8}, (_, index) => ["value" + index, u8({min: index})]));
const artifact = compileSchema(strictObject({...properties, meta: strictObject({code: u8()}), tags: array(string({maxLength: 32}), {maxLength: 4})}));
if (!(artifact.files.wasm instanceof Uint8Array) || !WebAssembly.validate(artifact.files.wasm)) throw new Error("package export did not compile Wasm");`,
    ],
    cwd: installDirectory,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!programmaticConsumer.success) {
    throw new Error(new TextDecoder().decode(programmaticConsumer.stderr));
  }

  const installedSchema = `${installDirectory}/wide-metrics.json`;
  await Deno.writeTextFile(installedSchema, JSON.stringify(wideNumericSchema(32)));
  const installedOutput = `${installDirectory}/generated/wide-metrics`;
  const installedCli = await new Deno.Command(
    `${installDirectory}/node_modules/.bin/jsimd-validator-compiler`,
    {
      args: [installedSchema, "--out", installedOutput],
      cwd: installDirectory,
      stdout: "piped",
      stderr: "piped",
    },
  ).output();
  if (!installedCli.success) throw new Error(new TextDecoder().decode(installedCli.stderr));

  const installedWasm = await Deno.readFile(`${installedOutput}.wasm`);
  if (!WebAssembly.validate(installedWasm as Uint8Array<ArrayBuffer>)) {
    throw new Error("installed package CLI generated an invalid Wasm module");
  }
  const installedFactory = await import(
    `${pathToFileUrl(installedOutput + ".js")}?smoke=${crypto.randomUUID()}`
  );
  const installedValidator = installedFactory.instantiate(installedWasm);
  const installedValid = Object.fromEntries(
    Array.from({ length: 32 }, (_, index) => [`value${index}`, index + 50]),
  );
  if (
    !installedValidator.is(installedValid) ||
    installedValidator.is({ ...installedValid, value31: 132 })
  ) {
    throw new Error("installed package Wasm validator has the wrong semantics");
  }
  for (const extension of ["js", "d.ts", "wasm"]) {
    await Deno.stat(`${installedOutput}.${extension}`);
  }
} finally {
  await Deno.remove(installDirectory, { recursive: true });
}

console.log(
  `${packageMetadata.name}@${packageMetadata.version} dist and npm package smoke passed ` +
    `(${size} bytes packed, ${unpackedSize} bytes unpacked)`,
);

function pathToFileUrl(path: string): string {
  return new URL(`file://${path}`).href;
}

function wideNumericSchema(width: number): unknown {
  const properties = Object.fromEntries(
    Array.from({ length: width }, (_, index) => [
      `value${index}`,
      { type: "number", minimum: index, maximum: index + 100 },
    ]),
  );
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}
