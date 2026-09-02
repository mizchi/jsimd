import { collectPixelBlockChangedEvents } from "../pixel_block_gpu_events.ts";
import { stepPixelWorldBlock } from "../pixel_block_sim.ts";
import { stepPixelReactions } from "../pixel_reaction.ts";
import { createPixelScenario, MATERIAL, packPixel } from "../pixel_sim.ts";
import { WebGpuBlockPixelSimulation } from "./pixel_block_webgpu.ts";
import { WebGpuBlockEventSimulation } from "./pixel_block_webgpu_events.ts";
import { WebGpuReactionEventSimulation } from "./pixel_reaction_webgpu_events.ts";

export interface PixelBlockWebGpuCheckResult {
  readonly width: number;
  readonly height: number;
  readonly ticks: number;
  readonly mismatches: number;
  readonly firstMismatch: number;
  readonly expected: number;
  readonly actual: number;
}

export interface PixelBlockWebGpuEventCheckResult {
  readonly width: number;
  readonly height: number;
  readonly ticks: number;
  readonly eventMismatches: number;
  readonly cellMismatches: number;
  readonly totalEvents: number;
  readonly droppedEvents: number;
  readonly overflowTotal: number;
  readonly overflowDropped: number;
  readonly readbackMedianMs: number;
}

export interface PixelReactionWebGpuEventCheckResult {
  readonly width: number;
  readonly height: number;
  readonly ticks: number;
  readonly eventMismatches: number;
  readonly cellMismatches: number;
  readonly totalEvents: number;
  readonly droppedEvents: number;
  readonly overflowTotal: number;
  readonly overflowDropped: number;
}

/** Browser-only, explicit-readback conformance check. Not imported by the demo runtime. */
export async function checkPixelBlockWebGpu(): Promise<PixelBlockWebGpuCheckResult> {
  const width = 63;
  const height = 41;
  const ticks = 48;
  const initial = createPixelScenario(width, height, 0.37, 0x6a09_e667, "full");
  seedExtraMaterials(initial, width, height);
  const expected = initial.slice();
  for (let tick = 0; tick < ticks; tick++) stepPixelWorldBlock(expected, width, height, tick);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.hidden = true;
  document.body.append(canvas);
  const simulation = await WebGpuBlockPixelSimulation.create(canvas, initial, width, height);
  try {
    for (let tick = 0; tick < ticks; tick++) await simulation.step(tick);
    const actual = await simulation.readCells();
    let mismatches = 0;
    let firstMismatch = -1;
    for (let index = 0; index < expected.length; index++) {
      if (expected[index] === actual[index]) continue;
      mismatches++;
      if (firstMismatch === -1) firstMismatch = index;
    }
    return {
      width,
      height,
      ticks,
      mismatches,
      firstMismatch,
      expected: firstMismatch === -1 ? 0 : expected[firstMismatch]!,
      actual: firstMismatch === -1 ? 0 : actual[firstMismatch]!,
    };
  } finally {
    await simulation[Symbol.asyncDispose]();
    canvas.remove();
  }
}

export async function checkPixelBlockWebGpuEvents(): Promise<PixelBlockWebGpuEventCheckResult> {
  const width = 31;
  const height = 21;
  const ticks = 12;
  const capacity = 512;
  const initial = createPixelScenario(width, height, 0.37, 0x6a09_e667, "full");
  seedExtraMaterials(initial, width, height);
  const expected = initial.slice();
  const simulation = await WebGpuBlockEventSimulation.create(
    initial,
    width,
    height,
    capacity,
  );
  let eventMismatches = 0;
  let totalEvents = 0;
  let droppedEvents = 0;
  const readbackSamples: number[] = [];
  try {
    for (let tick = 0; tick < ticks; tick++) {
      const before = expected.slice();
      stepPixelWorldBlock(expected, width, height, tick);
      const wanted = collectPixelBlockChangedEvents(
        before,
        expected,
        width,
        height,
        tick,
        capacity,
      );
      const actual = await simulation.stepAndReadEvents(tick);
      totalEvents += actual.total;
      droppedEvents += actual.dropped;
      readbackSamples.push(actual.readbackMs);
      if (
        actual.total !== wanted.total || actual.dropped !== wanted.dropped ||
        JSON.stringify(sortedRecords(actual.records)) !==
          JSON.stringify(sortedRecords(wanted.records))
      ) eventMismatches++;
    }
    const actualCells = await simulation.readCells();
    const cellMismatches = mismatchCount(actualCells, expected);
    const overflow = await checkOverflow(initial, width, height);
    return {
      width,
      height,
      ticks,
      eventMismatches,
      cellMismatches,
      totalEvents,
      droppedEvents,
      overflowTotal: overflow.total,
      overflowDropped: overflow.dropped,
      readbackMedianMs: median(readbackSamples),
    };
  } finally {
    await simulation[Symbol.asyncDispose]();
  }
}

export async function checkPixelReactionWebGpuEvents(): Promise<
  PixelReactionWebGpuEventCheckResult
> {
  const width = 19;
  const height = 11;
  const ticks = 12;
  const capacity = 512;
  const initial = reactionFixture(width, height);
  const expected = initial.slice();
  const scratch = new Uint32Array(expected.length);
  const simulation = await WebGpuReactionEventSimulation.create(
    initial,
    width,
    height,
    capacity,
  );
  let eventMismatches = 0;
  let totalEvents = 0;
  let droppedEvents = 0;
  let wantedRecords: number[] = [];
  let wantedTotal = 0;
  let firstTick = 0;
  try {
    for (let tick = 0; tick < ticks; tick++) {
      const wanted = stepPixelReactions(
        expected,
        scratch,
        width,
        height,
        (kind, index, before, after) => wantedRecords.push(kind, index, before, after),
      );
      wantedTotal += wanted.reactions;
      simulation.step(tick);
      if ((tick + 1) % 3 !== 0) continue;
      const actual = await simulation.readEvents();
      totalEvents += actual.total;
      droppedEvents += actual.dropped;
      if (
        actual.total !== wantedTotal || actual.dropped !== 0 ||
        actual.firstTick !== firstTick || actual.tickCount !== 3 || actual.tick !== tick ||
        JSON.stringify(sortedRecords(actual.records)) !==
          JSON.stringify(sortedRecords(new Uint32Array(wantedRecords)))
      ) eventMismatches++;
      wantedRecords = [];
      wantedTotal = 0;
      firstTick = tick + 1;
    }
    const actualCells = await simulation.readCells();
    const cellMismatches = mismatchCount(actualCells, expected);
    const overflow = await checkReactionOverflow(initial, width, height);
    return {
      width,
      height,
      ticks,
      eventMismatches,
      cellMismatches,
      totalEvents,
      droppedEvents,
      overflowTotal: overflow.total,
      overflowDropped: overflow.dropped,
    };
  } finally {
    await simulation[Symbol.asyncDispose]();
  }
}

function seedExtraMaterials(cells: Uint32Array, width: number, height: number): void {
  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      const index = y * width + x;
      if (index % 97 === 0) cells[index] = MATERIAL.gas | ((index & 0xff) << 8);
      if (index % 211 === 0) cells[index] = MATERIAL.fire | ((index & 0xff) << 8);
    }
  }
}

async function checkOverflow(
  initial: Uint32Array,
  width: number,
  height: number,
): Promise<{ readonly total: number; readonly dropped: number }> {
  const simulation = await WebGpuBlockEventSimulation.create(initial, width, height, 2);
  try {
    const result = await simulation.stepAndReadEvents(0);
    if (result.total <= 2 || result.dropped !== result.total - 2) {
      throw new Error(`invalid bounded event overflow: ${JSON.stringify(result)}`);
    }
    return result;
  } finally {
    await simulation[Symbol.asyncDispose]();
  }
}

async function checkReactionOverflow(
  initial: Uint32Array,
  width: number,
  height: number,
): Promise<{ readonly total: number; readonly dropped: number }> {
  const simulation = await WebGpuReactionEventSimulation.create(initial, width, height, 2);
  try {
    const result = await simulation.stepAndReadEvents(0);
    if (result.total <= 2 || result.dropped !== result.total - 2) {
      throw new Error(`invalid bounded reaction overflow: ${JSON.stringify(result)}`);
    }
    return result;
  } finally {
    await simulation[Symbol.asyncDispose]();
  }
}

function reactionFixture(width: number, height: number): Uint32Array {
  const cells = new Uint32Array(width * height);
  for (let index = 0; index < cells.length; index++) {
    const sample = index % 11;
    const material = sample === 0
      ? MATERIAL.fire
      : sample < 5
      ? MATERIAL.water
      : sample < 8
      ? MATERIAL.gas
      : MATERIAL.empty;
    const temperature = material === MATERIAL.fire
      ? 255
      : material === MATERIAL.gas
      ? 64 + index % 32
      : 128 + index % 16;
    cells[index] = packPixel(material, temperature, index & 7, index & 15);
  }
  return cells;
}

function sortedRecords(records: Uint32Array): readonly number[][] {
  const output: number[][] = [];
  for (let offset = 0; offset < records.length; offset += 4) {
    output.push(Array.from(records.slice(offset, offset + 4)));
  }
  return output.sort((left, right) => left[1]! - right[1]!);
}

function mismatchCount(left: Uint32Array, right: Uint32Array): number {
  let count = 0;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) count++;
  }
  return count;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}
