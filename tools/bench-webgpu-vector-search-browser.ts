import { detectHostCpu, runBrowserBenchmark } from "../packages/bench/src/browser_runner.ts";
import { type BenchmarkResultV1, validateBenchmarkResult } from "../packages/bench/src/result.ts";

const root = new URL(
  "../experiments/webgpu-vector-search/browser-benchmark/dist/",
  import.meta.url,
);
const debugBrowser = Deno.env.get("JSIMD_BROWSER_DEBUG") === "1";
const result = await runBrowserBenchmark<BenchmarkResultV1>({
  root,
  query: {
    benchmark: "webgpu",
    rows: Deno.env.get("JSIMD_WEBGPU_ROWS") ?? "1024,4096,16384,65536,262144",
    dimensions: Deno.env.get("JSIMD_WEBGPU_DIMENSIONS") ?? "128",
    batches: Deno.env.get("JSIMD_WEBGPU_BATCHES") ?? "1,4,16,64,128",
    inFlight: Deno.env.get("JSIMD_WEBGPU_IN_FLIGHT") ?? "1,2,3",
    workers: Deno.env.get("JSIMD_WEBGPU_WORKERS") ?? "4",
    k: Deno.env.get("JSIMD_WEBGPU_K") ?? "10",
    warmups: Deno.env.get("JSIMD_WEBGPU_WARMUPS") ?? "5",
    samples: Deno.env.get("JSIMD_WEBGPU_SAMPLES") ?? "15",
    cpu: await detectHostCpu(),
  },
  profilePrefix: "jsimd-webgpu-vector-search-",
  browserArgs: [
    "--enable-unsafe-webgpu",
    ...(debugBrowser ? ["--enable-logging=stderr"] : []),
  ],
  browserStderr: debugBrowser ? "inherit" : "null",
  onProgress: debugBrowser ? (value) => console.error("browser progress", value) : undefined,
  timeoutMs: 900_000,
  validate: validateBenchmarkResult,
});
const json = JSON.stringify(result, null, 2) + "\n";
const output = Deno.env.get("JSIMD_WEBGPU_BROWSER_OUTPUT");
if (output !== undefined) await Deno.writeTextFile(output, json);
console.log(json);
