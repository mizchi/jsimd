import { createPixelScenario, MATERIAL, packPixel } from "../pixel_sim.ts";
import { WasmSimdPixelReaction } from "../pixel_reaction_kernel.ts";
import {
  type PixelReactionGpuEventReadback,
  WebGpuReactionEventSimulation,
} from "./pixel_reaction_webgpu_events.ts";

const WIDTHS = [256, 512, 1_024] as const;
const CAPACITY = 256;
const TICKS = 400;
const WARMUP_TICKS = 40;

export interface PixelReactionWebGpuEventBenchmarkCase {
  readonly width: number;
  readonly height: number;
  readonly capacity: number;
  readonly ticks: number;
  readonly cadence: number;
  readonly totalEvents: number;
  readonly retainedEvents: number;
  readonly droppedEvents: number;
  readonly residentBytes: number;
  readonly readbackBytes: number;
  readonly stagingBytes: number;
  readonly elapsedPerTickMs: number;
  readonly readbackSamplesMs: readonly number[];
  readonly submitSamplesMs: readonly number[];
  readonly stateMismatches: number;
}

export interface PixelReactionWasmBenchmarkCase {
  readonly width: number;
  readonly height: number;
  readonly totalEvents: number;
  readonly droppedEvents: number;
  readonly residentBytes: number;
  readonly elapsedPerTickMs: number;
  readonly samplesMs: readonly number[];
}

export interface PixelReactionWebGpuEventBenchmarkResult {
  readonly gpu: readonly PixelReactionWebGpuEventBenchmarkCase[];
  readonly wasm: readonly PixelReactionWasmBenchmarkCase[];
  readonly adapter: string;
  readonly browser: {
    readonly userAgent: string;
    readonly platform: string;
    readonly logicalCpus: number;
  };
}

export async function runPixelReactionWebGpuEventBenchmark(): Promise<
  PixelReactionWebGpuEventBenchmarkResult
> {
  const gpu: PixelReactionWebGpuEventBenchmarkCase[] = [];
  const wasm: PixelReactionWasmBenchmarkCase[] = [];
  let adapter = "WebGPU";
  for (const width of WIDTHS) {
    const height = width * 5 / 8;
    const initial = createReactionBurst(width, height);
    const expected = await runWasm(initial, width, height);
    wasm.push(expected);
    for (const cadence of [1, 4]) {
      const result = await runGpu(initial, expected, width, height, cadence);
      adapter = result.adapter;
      gpu.push(result.case);
    }
  }
  return {
    gpu,
    wasm,
    adapter,
    browser: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      logicalCpus: navigator.hardwareConcurrency,
    },
  };
}

async function runGpu(
  initial: Uint32Array,
  expected: PixelReactionWasmBenchmarkCase & { readonly cells: Uint32Array },
  width: number,
  height: number,
  cadence: number,
): Promise<{
  readonly adapter: string;
  readonly case: PixelReactionWebGpuEventBenchmarkCase;
}> {
  const simulation = await WebGpuReactionEventSimulation.create(
    initial,
    width,
    height,
    CAPACITY,
  );
  const readbackSamplesMs: number[] = [];
  const submitSamplesMs: number[] = [];
  const pending: Promise<PixelReactionGpuEventReadback>[] = [];
  let totalEvents = 0;
  let retainedEvents = 0;
  let droppedEvents = 0;
  const consume = async (readback: Promise<PixelReactionGpuEventReadback>): Promise<void> => {
    const result = await readback;
    totalEvents += result.total;
    retainedEvents += result.records.length / 4;
    droppedEvents += result.dropped;
    if (result.firstTick >= WARMUP_TICKS) readbackSamplesMs.push(result.readbackMs);
  };
  try {
    const started = performance.now();
    for (let tick = 0; tick < TICKS; tick++) {
      const submitStarted = performance.now();
      simulation.step(tick);
      const readback = (tick + 1) % cadence === 0 ? simulation.readEvents() : undefined;
      if (tick >= WARMUP_TICKS) submitSamplesMs.push(performance.now() - submitStarted);
      if (readback === undefined) continue;
      if (cadence === 1) {
        await consume(readback);
        continue;
      }
      pending.push(readback);
      if (pending.length === 3) await consume(pending.shift()!);
    }
    while (pending.length > 0) await consume(pending.shift()!);
    const elapsedPerTickMs = (performance.now() - started) / TICKS;
    const cells = await simulation.readCells();
    return {
      adapter: adapterLabel(simulation.adapterInfo),
      case: {
        width,
        height,
        capacity: CAPACITY,
        ticks: TICKS,
        cadence,
        totalEvents,
        retainedEvents,
        droppedEvents,
        residentBytes: simulation.residentBytes,
        readbackBytes: simulation.readbackBytes,
        stagingBytes: simulation.stagingBytes,
        elapsedPerTickMs,
        readbackSamplesMs,
        submitSamplesMs,
        stateMismatches: mismatchCount(cells, expected.cells),
      },
    };
  } finally {
    await simulation[Symbol.asyncDispose]();
  }
}

async function runWasm(
  initial: Uint32Array,
  width: number,
  height: number,
): Promise<PixelReactionWasmBenchmarkCase & { readonly cells: Uint32Array }> {
  const simulation = await WasmSimdPixelReaction.create(initial, width, height, CAPACITY);
  const samplesMs: number[] = [];
  let totalEvents = 0;
  let droppedEvents = 0;
  const allStarted = performance.now();
  for (let tick = 0; tick < TICKS; tick++) {
    const started = performance.now();
    const result = simulation.step();
    const elapsed = performance.now() - started;
    totalEvents += result.reactions;
    droppedEvents += result.dropped;
    if (tick >= WARMUP_TICKS) samplesMs.push(elapsed);
  }
  return {
    width,
    height,
    totalEvents,
    droppedEvents,
    residentBytes: simulation.memory.buffer.byteLength,
    elapsedPerTickMs: (performance.now() - allStarted) / TICKS,
    samplesMs,
    cells: simulation.cells.slice(),
  };
}

function mismatchCount(left: Uint32Array, right: Uint32Array): number {
  let count = 0;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) count++;
  }
  return count;
}

function createReactionBurst(width: number, height: number): Uint32Array {
  const cells = createPixelScenario(width, height, 0.25, 0x51f1_5e5d, "full");
  const fire = packPixel(MATERIAL.fire, 255);
  const water = packPixel(MATERIAL.water, 128);
  for (let y = 64; y < height - 64; y += 128) {
    for (let x = 64; x < width - 64; x += 128) {
      const center = y * width + x;
      cells[center] = fire;
      cells[center - 1] = water;
      cells[center + 1] = water;
      cells[center - width] = water;
      cells[center + width] = water;
    }
  }
  return cells;
}

function adapterLabel(info: GPUAdapterInfo): string {
  return info.description || info.device || info.architecture || info.vendor || "WebGPU";
}
