import { runPixelReactionWebGpuEventBenchmark } from "../browser-ui/pixel_reaction_webgpu_event_bench.ts";

try {
  const pixelReactionWebGpuEventBenchmark = await runPixelReactionWebGpuEventBenchmark();
  await fetch("/__benchmark_report", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pixelReactionWebGpuEventBenchmark }),
  });
} catch (error) {
  await fetch("/__benchmark_report", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
  });
}
