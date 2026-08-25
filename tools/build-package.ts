const outputDirectory = "dist";

try {
  const stat = await Deno.stat(outputDirectory);
  if (!stat.isDirectory) throw new Error(`${outputDirectory} must be a directory`);
  await Deno.remove(outputDirectory, { recursive: true });
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
}

await run("pnpm", ["exec", "tsc", "-p", "tsconfig.publish.json", "--pretty", "false"]);

for await (const entry of Deno.readDir("src")) {
  if (!entry.isDirectory || entry.name === "internal") continue;
  const sourceDirectory = `src/${entry.name}`;
  const targetDirectory = `${outputDirectory}/${entry.name}`;
  for (const filename of ["kernels.wasm", "kernels.wat", "README.md"]) {
    try {
      await Deno.copyFile(`${sourceDirectory}/${filename}`, `${targetDirectory}/${filename}`);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
}

for (const path of await collectFiles(outputDirectory)) {
  if (!path.endsWith(".d.ts")) continue;
  const source = await Deno.readTextFile(path);
  const rewritten = source.replace(
    /((?:from\s+|import\s*\(\s*)["'][^"']+)\.ts(["'])/g,
    "$1.js$2",
  );
  await Deno.writeTextFile(path, rewritten);
}

const emittedFiles = await collectFiles(outputDirectory);
for (const path of emittedFiles) {
  if (!path.endsWith(".js") && !path.endsWith(".d.ts")) continue;
  const source = await Deno.readTextFile(path);
  if (/from\s+["'][^"']+\.ts["']/.test(source)) {
    throw new Error(`TypeScript runtime reference remains in ${path}`);
  }
  if (/from\s+["']\.\/kernels\.wasm["']/.test(source)) {
    const wasmPath = `${path.substring(0, path.lastIndexOf("/"))}/kernels.wasm`;
    await Deno.stat(wasmPath);
  }
}

console.log(`Built ${emittedFiles.length} publishable files in ${outputDirectory}/`);

async function collectFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory) files.push(...await collectFiles(path));
    else if (entry.isFile) files.push(path);
  }
  return files.sort();
}

async function run(command: string, args: string[]): Promise<void> {
  const status = await new Deno.Command(command, { args, stdin: "null" }).spawn().status;
  if (!status.success) throw new Error(`${command} ${args.join(" ")} failed`);
}
