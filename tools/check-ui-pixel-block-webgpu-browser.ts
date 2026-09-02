import { runBrowserBenchmark } from "../packages/bench/src/browser_runner.ts";

interface PostedResult {
  readonly pixelBlockWebGpuCheck: {
    readonly width: number;
    readonly height: number;
    readonly ticks: number;
    readonly mismatches: number;
    readonly firstMismatch: number;
    readonly expected: number;
    readonly actual: number;
  };
}

const root = new URL("../experiments/ui-core-simd/browser-ui/dist/", import.meta.url);
const result = await runBrowserBenchmark<PostedResult>({
  root,
  query: { run: "pixel-block-webgpu-check" },
  resultPath: "/__benchmark_report",
  timeoutMs: 30_000,
  profilePrefix: "jsimd-pixel-block-webgpu-check-",
  browserArgs: ["--enable-unsafe-webgpu"],
  validate(value): asserts value is PostedResult {
    const check = (value as Partial<PostedResult>).pixelBlockWebGpuCheck;
    if (check === undefined || check.mismatches !== 0) {
      throw new Error(`WebGPU block mismatch: ${JSON.stringify(check)}`);
    }
  },
});

console.log(JSON.stringify(result.pixelBlockWebGpuCheck));
