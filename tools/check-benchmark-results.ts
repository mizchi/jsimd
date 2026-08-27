import { validateBenchmarkResult } from "./benchmark/result.ts";

const roots = [
  new URL("../experiments/", import.meta.url),
  new URL("../examples/", import.meta.url),
] as const;
let versioned = 0;
const unversionedRequired: string[] = [];
for (const root of roots) {
  for await (const url of benchmarkJsonFiles(root)) {
    const value = JSON.parse(await Deno.readTextFile(url)) as unknown;
    if (
      typeof value === "object" && value !== null &&
      "schemaVersion" in value
    ) {
      try {
        validateBenchmarkResult(value);
      } catch (error) {
        throw new Error(
          `${url.pathname}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      versioned++;
    } else {
      unversionedRequired.push(url.pathname);
    }
  }
}
if (versioned === 0) throw new Error("no versioned benchmark result was found");
if (unversionedRequired.length > 0) {
  throw new Error(
    `All benchmark results must use the versioned schema:\n${unversionedRequired.join("\n")}`,
  );
}
console.log(
  `Validated ${versioned} versioned benchmark result(s); no legacy results found`,
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
