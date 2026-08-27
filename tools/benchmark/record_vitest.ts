const [suite, output] = Deno.args;
if (suite === undefined || output === undefined) {
  console.error("usage: record_vitest.ts <suite-directory> <output.json>");
  Deno.exit(2);
}

const name = suite.replace(/^experiments\//, "").replace(/\/$/, "");
const command = new Deno.Command("pnpm", {
  args: [
    "exec",
    "vitest",
    "bench",
    suite,
    "--config",
    "tools/benchmark/vitest_record.config.ts",
  ],
  env: {
    JSIMD_VITEST_NAME: name,
    JSIMD_VITEST_OUTPUT: output,
  },
  stdout: "inherit",
  stderr: "inherit",
});
const status = await command.spawn().status;
if (!status.success) Deno.exit(status.code);
