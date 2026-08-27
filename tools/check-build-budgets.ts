import { type BuildBudgetManifest, checkBuildBudgets } from "../packages/bench/src/build_budget.ts";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(
  await Deno.readTextFile(new URL("../packages/bench/build-budgets.json", import.meta.url)),
) as BuildBudgetManifest;
const packageJson = JSON.parse(
  await Deno.readTextFile(new URL("packages/jsimd/package.json", root)),
) as {
  exports: Record<string, unknown>;
};
const summaries = await checkBuildBudgets(root, manifest, Object.keys(packageJson.exports));
console.log(`Checked ${summaries.length} isolated gzip budgets`);
for (const summary of summaries) console.log(summary);
