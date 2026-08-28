const packageName = Deno.args[0];
if (packageName !== "shared" && packageName !== "columnar") {
  throw new TypeError("expected package name: shared or columnar");
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

console.log(`Built ${packageName} package in ${outputDirectory}/`);
