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
  readonly pixelBlockWebGpuEventCheck: {
    readonly eventMismatches: number;
    readonly cellMismatches: number;
    readonly totalEvents: number;
    readonly droppedEvents: number;
    readonly overflowTotal: number;
    readonly overflowDropped: number;
    readonly readbackMedianMs: number;
  };
  readonly pixelReactionWebGpuEventCheck: {
    readonly eventMismatches: number;
    readonly cellMismatches: number;
    readonly totalEvents: number;
    readonly droppedEvents: number;
    readonly overflowTotal: number;
    readonly overflowDropped: number;
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
    const events = (value as Partial<PostedResult>).pixelBlockWebGpuEventCheck;
    const reactions = (value as Partial<PostedResult>).pixelReactionWebGpuEventCheck;
    if (
      check === undefined || check.mismatches !== 0 || events === undefined ||
      events.eventMismatches !== 0 || events.cellMismatches !== 0 ||
      events.droppedEvents !== 0 || events.overflowTotal <= 2 ||
      events.overflowDropped !== events.overflowTotal - 2 || reactions === undefined ||
      reactions.eventMismatches !== 0 || reactions.cellMismatches !== 0 ||
      reactions.droppedEvents !== 0 || reactions.overflowTotal <= 2 ||
      reactions.overflowDropped !== reactions.overflowTotal - 2
    ) {
      throw new Error(`WebGPU block mismatch: ${JSON.stringify(check)}`);
    }
  },
});

console.log(JSON.stringify(result));
