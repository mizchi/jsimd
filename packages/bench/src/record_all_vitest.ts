const workspaceRoot = new URL("../../../", import.meta.url);
const justfile = await Deno.readTextFile(new URL("justfile", workspaceRoot));
const records = Array.from(
  justfile.matchAll(/^([a-z0-9-]+):\n\s+just bench-record-vitest\s/gm),
  (match) => match[1]!,
);

if (records.length === 0) throw new Error("no Vitest benchmark record recipes found");
for (const [index, recipe] of records.entries()) {
  console.log(`[${index + 1}/${records.length}] ${recipe}`);
  const command = new Deno.Command("just", {
    args: [recipe],
    cwd: workspaceRoot.pathname,
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await command.spawn().status;
  if (!status.success) Deno.exit(status.code);
}
