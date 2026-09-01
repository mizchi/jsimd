const fixtureDirectory = new URL("../packages/validator/fixtures/comparison/", import.meta.url);
const outputDirectory = new URL("dist/", fixtureDirectory);
const libraries = ["jsimd", "zod", "zod-mini", "valibot", "arktype"] as const;
const jsimdGzipBudget = 1_300;

await Deno.mkdir(outputDirectory, { recursive: true });
const rows: Array<{ library: string; minified: number; gzip: number }> = [];

for (const library of libraries) {
  const output = new URL(`${library}.js`, outputDirectory);
  const command = new Deno.Command("pnpm", {
    args: [
      "exec",
      "esbuild",
      new URL(`${library}.ts`, fixtureDirectory).pathname,
      "--bundle",
      "--format=esm",
      "--minify",
      "--platform=browser",
      "--target=es2022",
      `--outfile=${output.pathname}`,
    ],
    stdout: "null",
  });
  const result = await command.output();
  if (!result.success) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  const bytes = await Deno.readFile(output);
  const gzip = await new Response(
    new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")),
  ).bytes();
  rows.push({ library, minified: bytes.byteLength, gzip: gzip.byteLength });
}

console.log("| library | minified | gzip |");
console.log("| --- | ---: | ---: |");
for (const row of rows) {
  const label = row.library === "jsimd" ? "jsimd internal scalar" : row.library;
  console.log(`| ${label} | ${format(row.minified)} | ${format(row.gzip)} |`);
}

const jsimd = rows.find((row) => row.library === "jsimd")!;
if (jsimd.gzip > jsimdGzipBudget) {
  throw new Error(
    `jsimd comparison bundle exceeds gzip budget: ${jsimd.gzip} > ${jsimdGzipBudget}`,
  );
}

function format(bytes: number): string {
  return `${(bytes / 1_000).toFixed(2)} kB`;
}
