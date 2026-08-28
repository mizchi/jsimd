const packageName = Deno.args[0];
if (packageName !== "shared" && packageName !== "columnar" && packageName !== "olap") {
  throw new TypeError("expected package name: shared, columnar, or olap");
}

const packageDirectory = `packages/${packageName}`;
const outputDirectory = `${packageDirectory}/dist`;

try {
  const stat = await Deno.stat(outputDirectory);
  if (!stat.isDirectory) throw new Error(`${outputDirectory} must be a directory`);
  await Deno.remove(outputDirectory, { recursive: true });
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
}

const command = new Deno.Command("pnpm", {
  args: ["exec", "tsc", "-p", `${packageDirectory}/tsconfig.json`, "--pretty", "false"],
  stdin: "null",
});
const status = await command.spawn().status;
if (!status.success) throw new Error(`failed to build ${packageDirectory}`);

if (packageName === "olap") {
  for (
    const file of [
      "group_by.js",
      "local_group_hash_worker_pool.js",
      "mod.js",
      "partitioned_hash_join_worker_pool.js",
    ]
  ) {
    const path = `${outputDirectory}/${file}`;
    const source = await Deno.readTextFile(path);
    await Deno.writeTextFile(path, source.replaceAll(/(new URL\("\.\/[^\"]+)\.ts"/g, '$1.js"'));
  }
  await Deno.copyFile(`${packageDirectory}/src/kernels.wasm`, `${outputDirectory}/kernels.wasm`);
  await Deno.copyFile(
    `${packageDirectory}/src/radix_order_u32.wasm`,
    `${outputDirectory}/radix_order_u32.wasm`,
  );
}

console.log(`Built ${packageName} package in ${outputDirectory}/`);
