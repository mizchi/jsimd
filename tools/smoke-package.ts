const metadata = JSON.parse(await Deno.readTextFile("package.json")) as {
  name: string;
  version: string;
};
const temporaryDirectory = await Deno.makeTempDir({ prefix: "jsimd-package-smoke-" });

try {
  const packed = await run(
    "npm",
    ["pack", "--silent", "--ignore-scripts", "--pack-destination", temporaryDirectory],
    Deno.cwd(),
  );
  const archive = packed.trim().split("\n").at(-1);
  if (!archive) throw new Error("npm pack did not report an archive");
  await run(
    "npm",
    ["install", "--silent", "--ignore-scripts", `${temporaryDirectory}/${archive}`],
    temporaryDirectory,
  );

  const expression =
    `import { DenseBitmap } from "${metadata.name}/bitmap"; import { RankSelectBitVector } from "${metadata.name}/rank-select-bit-vector"; import { RoaringBitmap } from "${metadata.name}/roaring-bitmap"; using bits = DenseBitmap.from(128, [1, 10]); using ranked = RankSelectBitVector.from(128, [1, 10]); using roaring = RoaringBitmap.from([1, 10]); if (bits.countOnes() !== 2 || ranked.rank1(128) !== 2 || roaring.size !== 2) throw new Error("unexpected SIMD result");`;
  await run("node", ["--input-type=module", "--eval", expression], temporaryDirectory);

  for (
    const removedSubpath of [
      "bitset",
      "bit-vector",
      "rank-select-bitvector",
      "rank-select-bitmap",
      "roaring-uint32-set",
      "static-mphf-bytes",
    ]
  ) {
    await assertImportFails(`${metadata.name}/${removedSubpath}`, temporaryDirectory);
  }

  for (
    const rejectedDirectory of ["static-mphf-bytes", "packed-uint32-array", "packed-delta-array"]
  ) {
    await assertPathMissing(
      `${temporaryDirectory}/node_modules/${metadata.name}/dist/${rejectedDirectory}`,
    );
  }

  const installedModule = `${temporaryDirectory}/node_modules/${metadata.name}/dist/bitmap/mod.js`;
  const denoExpression = `import { DenseBitmap } from ${
    JSON.stringify(installedModule)
  }; using bits = DenseBitmap.from(128, [1, 10]); if (bits.countOnes() !== 2) throw new Error("unexpected SIMD result");`;
  await run("deno", ["eval", denoExpression], temporaryDirectory);

  await Deno.writeTextFile(
    `${temporaryDirectory}/consumer.ts`,
    `import { DenseBitmap } from "${metadata.name}/bitmap";
import { RankSelectBitVector } from "${metadata.name}/rank-select-bit-vector";
import { RoaringBitmap } from "${metadata.name}/roaring-bitmap";
using bits = DenseBitmap.from(128, [1, 10]);
using ranked = RankSelectBitVector.from(128, [1, 10]);
using roaring = RoaringBitmap.from([1, 10]);
const count: number = bits.countOnes();
const rank: number = ranked.rank1(128);
const roaringCount: number = roaring.size;
void count;
void rank;
void roaringCount;
`,
  );
  await run(
    `${Deno.cwd()}/node_modules/.bin/tsc`,
    [
      "--noEmit",
      "--strict",
      "--target",
      "ESNext",
      "--module",
      "ESNext",
      "--moduleResolution",
      "Bundler",
      "consumer.ts",
    ],
    temporaryDirectory,
  );

  console.log(
    `${metadata.name}@${metadata.version} package smoke test passed in Node, Deno, and TypeScript`,
  );
} finally {
  await Deno.remove(temporaryDirectory, { recursive: true });
}

async function run(command: string, args: string[], cwd: string): Promise<string> {
  const result = await new Deno.Command(command, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  if (!result.success) {
    throw new Error(`${command} ${args.join(" ")} failed\n${stdout}${stderr}`);
  }
  return stdout;
}

async function assertImportFails(specifier: string, cwd: string): Promise<void> {
  const result = await new Deno.Command("node", {
    args: ["--input-type=module", "--eval", `await import(${JSON.stringify(specifier)})`],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (result.success) throw new Error(`removed package subpath still resolves: ${specifier}`);
}

async function assertPathMissing(path: string): Promise<void> {
  try {
    await Deno.stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  throw new Error(`rejected implementation was included in the package: ${path}`);
}
