interface PackageManifest {
  readonly scripts?: Readonly<Record<string, string>>;
}

const manifest = JSON.parse(await Deno.readTextFile("package.json")) as PackageManifest;
const records = Object.entries(manifest.scripts ?? {})
  .filter(([script, command]) =>
    script !== "bench:record:vitest" && command.includes("pnpm bench:record:vitest ")
  )
  .map(([script]) => script);

if (records.length === 0) throw new Error("no Vitest benchmark record scripts found");
for (const [index, script] of records.entries()) {
  console.log(`[${index + 1}/${records.length}] ${script}`);
  const command = new Deno.Command("pnpm", {
    args: ["run", script],
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await command.spawn().status;
  if (!status.success) Deno.exit(status.code);
}
