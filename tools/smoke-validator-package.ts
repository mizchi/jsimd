const packageDirectory = new URL("../packages/validator/", import.meta.url);
const packageMetadata = JSON.parse(
  await Deno.readTextFile(new URL("package.json", packageDirectory)),
) as { name: string; version: string };
const denoMetadata = JSON.parse(
  await Deno.readTextFile(new URL("deno.json", packageDirectory)),
) as { name: string; version: string };

const packageExports = JSON.parse(
  await Deno.readTextFile(new URL("package.json", packageDirectory)),
) as { exports: Record<string, string> };
const denoExports = JSON.parse(
  await Deno.readTextFile(new URL("deno.json", packageDirectory)),
) as { exports: Record<string, string> };
if (
  packageMetadata.name !== denoMetadata.name || packageMetadata.version !== denoMetadata.version ||
  JSON.stringify(Object.keys(packageExports.exports)) !== JSON.stringify([".", "./debug"]) ||
  JSON.stringify(Object.keys(denoExports.exports)) !== JSON.stringify([".", "./debug"])
) throw new Error("validator package.json and deno.json release metadata differ");

const { compileSimd, float32Array, float64Array, int32Array, maxValue, minValue } = await import(
  "../packages/validator/dist/mod.js"
);
const simdValidator = await compileSimd(int32Array(minValue(0), maxValue(130)));
if (!simdValidator.is(new Int32Array([0, 36, 130]))) {
  throw new Error("validator SIMD rejected valid values");
}
if (simdValidator.is(new Int32Array([0, 131]))) {
  throw new Error("validator SIMD accepted an out-of-range value");
}

const float32Validator = await compileSimd(float32Array(maxValue(0.1)));
if (float32Validator.is(new Float32Array([0.1]))) {
  throw new Error("validator SIMD lost JavaScript semantics at a Float32 boundary");
}
const float64Validator = await compileSimd(float64Array());
if (
  !float64Validator.is(new Float64Array([-0, Number.MIN_VALUE])) ||
  float64Validator.is(new Float64Array([Number.NaN]))
) {
  throw new Error("validator SIMD violated its finite Float64 contract");
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
    "dist/debug.d.ts",
    "dist/debug.js",
    "dist/diagnostics.d.ts",
    "dist/diagnostics.js",
    "dist/mod.d.ts",
    "dist/mod.js",
    "dist/simd/kernels.wasm",
    "dist/simd/mod.d.ts",
    "dist/simd/mod.js",
    "LICENSE",
    "README.md",
  ]
) {
  if (!paths.has(required)) throw new Error(`validator package is missing ${required}`);
}
for (
  const internal of [
    "dist/check.js",
    "dist/actions.js",
    "dist/compile.js",
    "dist/parse.js",
    "dist/scalar.js",
    "dist/schemas.js",
    "dist/types.js",
  ]
) {
  if (paths.has(internal)) throw new Error(`validator package exposes scalar asset ${internal}`);
}
for (const path of paths) {
  if (path.includes("_test.")) throw new Error(`validator package includes a test file: ${path}`);
}

const installDirectory = await Deno.makeTempDir({ prefix: "jsimd-validator-pack-" });
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
  const installed = await new Deno.Command("npm", {
    args: [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      `${installDirectory}/${filename}`,
    ],
    cwd: installDirectory,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!installed.success) throw new Error(new TextDecoder().decode(installed.stderr));

  const consumer = `${installDirectory}/consumer.mjs`;
  await Deno.writeTextFile(
    consumer,
    `import { compileSimd, int32Array, minValue, maxValue } from "@mizchi/jsimd-validator";
const validator = await compileSimd(int32Array(minValue(0), maxValue(130)));
if (!validator.is(new Int32Array([0, 36, 130]))) throw new Error("installed validator rejected valid input");
if (validator.is(new Int32Array([131]))) throw new Error("installed validator accepted invalid input");
`,
  );
  const consumed = await new Deno.Command("node", {
    args: [consumer],
    cwd: installDirectory,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!consumed.success) throw new Error(new TextDecoder().decode(consumed.stderr));
} finally {
  await Deno.remove(installDirectory, { recursive: true });
}

console.log(
  `${packageMetadata.name}@${packageMetadata.version} dist and npm package smoke passed ` +
    `(${size} bytes packed, ${unpackedSize} bytes unpacked)`,
);
