import { pixelBlockGpuEventBytes } from "../pixel_block_gpu_events.ts";
import { createPixelScenario } from "../pixel_sim.ts";
import { WebGpuBlockEventSimulation } from "./pixel_block_webgpu_events.ts";

export interface PixelBlockWebGpuEventBenchmarkResult {
  readonly width: number;
  readonly height: number;
  readonly capacity: number;
  readonly ticks: number;
  readonly totalEvents: number;
  readonly retainedEvents: number;
  readonly droppedEvents: number;
  readonly residentBytes: number;
  readonly readbackBytesPerTick: number;
  readonly adapter: string;
  readonly samplesMs: readonly number[];
  readonly browser: {
    readonly userAgent: string;
    readonly platform: string;
    readonly logicalCpus: number;
  };
}

export async function runPixelBlockWebGpuEventBenchmark(): Promise<
  PixelBlockWebGpuEventBenchmarkResult
> {
  const width = 1_024;
  const height = 640;
  const capacity = 256;
  const warmups = 10;
  const ticks = 100;
  const initial = createPixelScenario(width, height, 0.25, 0x51f1_5e5d, "full");
  const simulation = await WebGpuBlockEventSimulation.create(initial, width, height, capacity);
  const samplesMs: number[] = [];
  let totalEvents = 0;
  let retainedEvents = 0;
  let droppedEvents = 0;
  try {
    for (let tick = 0; tick < ticks; tick++) {
      const result = await simulation.stepAndReadEvents(tick);
      totalEvents += result.total;
      retainedEvents += result.records.length / 4;
      droppedEvents += result.dropped;
      if (tick >= warmups) samplesMs.push(result.readbackMs);
    }
    return {
      width,
      height,
      capacity,
      ticks,
      totalEvents,
      retainedEvents,
      droppedEvents,
      residentBytes: simulation.residentBytes,
      readbackBytesPerTick: pixelBlockGpuEventBytes(capacity),
      adapter: adapterLabel(simulation.adapterInfo),
      samplesMs,
      browser: {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        logicalCpus: navigator.hardwareConcurrency,
      },
    };
  } finally {
    await simulation[Symbol.asyncDispose]();
  }
}

function adapterLabel(info: GPUAdapterInfo): string {
  return info.description || info.device || info.architecture || info.vendor || "WebGPU";
}
