import { validateBenchmarkResult } from "./benchmark/result.ts";

const root = new URL("../experiments/", import.meta.url);
let versioned = 0;
let legacy = 0;
for await (const url of benchmarkJsonFiles(root)) {
  const value = JSON.parse(await Deno.readTextFile(url)) as unknown;
  if (
    typeof value === "object" && value !== null &&
    "schemaVersion" in value
  ) {
    try {
      validateBenchmarkResult(value);
    } catch (error) {
      throw new Error(`${url.pathname}: ${error instanceof Error ? error.message : String(error)}`);
    }
    versioned++;
  } else {
    legacy++;
  }
}
if (versioned === 0) throw new Error("no versioned benchmark result was found");
console.log(
  `Validated ${versioned} versioned benchmark result(s); ${legacy} legacy file(s) remain`,
);

async function* benchmarkJsonFiles(directory: URL): AsyncGenerator<URL> {
  for await (const entry of Deno.readDir(directory)) {
    const url = new URL(`${entry.name}${entry.isDirectory ? "/" : ""}`, directory);
    if (entry.isDirectory) {
      yield* benchmarkJsonFiles(url);
    } else if (
      entry.isFile && entry.name.endsWith(".json") && directory.pathname.endsWith("/benchmarks/")
    ) {
      yield url;
    }
  }
}
