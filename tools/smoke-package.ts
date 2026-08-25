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
    `import { FixedBitSet } from "${metadata.name}/bitset"; using bits = FixedBitSet.from(128, [1, 10]); if (bits.countOnes() !== 2) throw new Error("unexpected SIMD result");`;
  await run("node", ["--input-type=module", "--eval", expression], temporaryDirectory);

  const installedModule = `${temporaryDirectory}/node_modules/${metadata.name}/dist/bitset/mod.js`;
  const denoExpression = `import { FixedBitSet } from ${
    JSON.stringify(installedModule)
  }; using bits = FixedBitSet.from(128, [1, 10]); if (bits.countOnes() !== 2) throw new Error("unexpected SIMD result");`;
  await run("deno", ["eval", denoExpression], temporaryDirectory);

  await Deno.writeTextFile(
    `${temporaryDirectory}/consumer.ts`,
    `import { FixedBitSet } from "${metadata.name}/bitset";
using bits = FixedBitSet.from(128, [1, 10]);
const count: number = bits.countOnes();
void count;
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
