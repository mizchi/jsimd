import {
  ATOMIC_INPUT_KIND,
  ATOMIC_INPUT_RECORD_WORDS,
  AtomicInputBuffer,
} from "../atomic_input.ts";
import { AtomicInputAsyncWaiter } from "../atomic_input_async.ts";
import { cellFromFixedPoint } from "../life_game.ts";
import type { PixelRegion } from "../pixel_options.ts";
import {
  MATERIAL,
  paintPixelCircle,
  paintPixelLine,
  type PixelMaterial,
  pixelMaterial,
} from "../pixel_sim.ts";
import { PixelWorkerControl } from "../pixel_worker_control.ts";
import { inputToPresentMicros } from "../pixel_worker_timing.ts";

export interface PixelWorkerInitMessage {
  readonly type: "init";
  readonly inputBuffer: SharedArrayBuffer;
  readonly controlBuffer: SharedArrayBuffer;
  readonly canvas: OffscreenCanvas;
  readonly occupancy: number;
  readonly region: PixelRegion;
  readonly mainTimeOriginMillis: number;
}

export interface PixelWorkerSimulation {
  step(tick: number): unknown;
  activateRect(left: number, top: number, right: number, bottom: number): void;
  readonly activeChunkCount: number;
}

export interface PixelWorkerBackend {
  readonly cells: Uint32Array;
  readonly simulation: PixelWorkerSimulation;
  readonly materialColors: readonly number[];
  normalizeMaterial(material: number): PixelMaterial;
}

export type PixelWorkerBackendFactory = (
  width: number,
  height: number,
  occupancy: number,
  region: PixelRegion,
) => PixelWorkerBackend | Promise<PixelWorkerBackend>;

/** Installs the shared Atomics input, simulation cadence, and OffscreenCanvas presentation loop. */
export function installPixelWorker(factory: PixelWorkerBackendFactory): void {
  self.onmessage = (event: MessageEvent<PixelWorkerInitMessage>) => {
    if (event.data.type !== "init") return;
    const input = AtomicInputBuffer.attach(event.data.inputBuffer);
    const control = PixelWorkerControl.attach(event.data.controlBuffer);
    void initialize(
      factory,
      input,
      control,
      event.data.canvas,
      event.data.occupancy,
      event.data.region,
      event.data.mainTimeOriginMillis,
    ).catch((error: unknown) => {
      self.postMessage({ type: "error", message: errorMessage(error) });
    });
  };
}

async function initialize(
  factory: PixelWorkerBackendFactory,
  input: AtomicInputBuffer,
  control: PixelWorkerControl,
  canvas: OffscreenCanvas,
  occupancy: number,
  region: PixelRegion,
  mainTimeOriginMillis: number,
): Promise<never> {
  const backend = await factory(control.width, control.height, occupancy, region);
  const { cells, simulation, materialColors } = backend;
  if (cells.length !== control.width * control.height) {
    throw new RangeError("pixel worker backend returned an invalid world");
  }
  const context = canvas.getContext("2d", { alpha: false });
  if (context === null) throw new Error("OffscreenCanvas 2D context is unavailable");
  const image = context.createImageData(control.width, control.height);
  const pixels = new Uint32Array(image.data.buffer);
  const latest = new Int32Array(ATOMIC_INPUT_RECORD_WORDS);
  const discrete = new Int32Array(input.capacity * ATOMIC_INPUT_RECORD_WORDS);
  let latestSequence = input.readLatestInto(latest);
  let dragging = false;
  let dragMaterial: PixelMaterial = MATERIAL.sand;
  let lastX = 0;
  let lastY = 0;
  let tick = 0;
  const brushRadius = Math.max(2, Math.floor(control.width / 128));

  const point = (records: Int32Array, offset: number) =>
    cellFromFixedPoint(
      records[offset + 2]!,
      records[offset + 3]!,
      control.viewport,
      control.width,
      control.height,
    );
  const activateStroke = (fromX: number, fromY: number, toX: number, toY: number): void => {
    simulation.activateRect(
      Math.min(fromX, toX) - brushRadius,
      Math.min(fromY, toY) - brushRadius,
      Math.max(fromX, toX) + brushRadius,
      Math.max(fromY, toY) + brushRadius,
    );
  };
  const paintPoint = (x: number, y: number): void => {
    paintPixelCircle(cells, control.width, control.height, x, y, brushRadius, dragMaterial);
    activateStroke(x, y, x, y);
  };
  const paintLine = (x: number, y: number): void => {
    paintPixelLine(
      cells,
      control.width,
      control.height,
      lastX,
      lastY,
      x,
      y,
      brushRadius,
      dragMaterial,
    );
    activateStroke(lastX, lastY, x, y);
    lastX = x;
    lastY = y;
  };
  const render = (): number => {
    const started = performance.now();
    for (let index = 0; index < cells.length; index++) {
      const material = pixelMaterial(cells[index]!);
      pixels[index] = materialColors[material] ?? materialColors[MATERIAL.empty]!;
    }
    context.putImageData(image, 0, 0);
    return (performance.now() - started) * 1_000;
  };

  control.publish(tick, 0, render(), simulation.activeChunkCount);
  self.postMessage({ type: "ready" });

  let nextStepAt = performance.now();
  const runCycle = (): { readonly wakeSequence: number; readonly timeout?: number } => {
    let changed = false;
    let inputTimeMicros: number | undefined;
    const discreteCount = input.drainInto(discrete);
    for (let record = 0; record < discreteCount; record++) {
      const offset = record * ATOMIC_INPUT_RECORD_WORDS;
      const kind = discrete[offset];
      if (kind === ATOMIC_INPUT_KIND.pointerDown) {
        const flags = discrete[offset + 5]! >>> 0;
        const button = ((flags >>> 16) & 0xff) - 1;
        dragMaterial = button === 2
          ? MATERIAL.empty
          : backend.normalizeMaterial(control.brushMaterial);
        const cell = point(discrete, offset);
        dragging = true;
        lastX = cell.x;
        lastY = cell.y;
        paintPoint(cell.x, cell.y);
        changed = true;
        inputTimeMicros = discrete[offset + 6]! >>> 0;
      } else if (kind === ATOMIC_INPUT_KIND.pointerUp) {
        if (dragging) {
          const cell = point(discrete, offset);
          paintLine(cell.x, cell.y);
          changed = true;
          inputTimeMicros = discrete[offset + 6]! >>> 0;
        }
        dragging = false;
      } else if (kind === ATOMIC_INPUT_KIND.pointerCancel) {
        dragging = false;
      }
    }

    const nextLatestSequence = input.readLatestInto(latest);
    if (
      dragging && nextLatestSequence !== 0 && nextLatestSequence !== latestSequence &&
      latest[0] === ATOMIC_INPUT_KIND.pointerMove
    ) {
      latestSequence = nextLatestSequence;
      const cell = point(latest, 0);
      paintLine(cell.x, cell.y);
      changed = true;
      inputTimeMicros = latest[6]! >>> 0;
    } else if (nextLatestSequence !== 0) {
      latestSequence = nextLatestSequence;
    }

    const now = performance.now();
    const interval = 1_000 / control.rate;
    let computeMicros = 0;
    if (control.running && now >= nextStepAt) {
      const started = performance.now();
      simulation.step(tick);
      computeMicros = (performance.now() - started) * 1_000;
      tick++;
      changed = true;
      nextStepAt = now + interval;
    }
    if (changed) {
      const renderMicros = render();
      const inputLatencyMicros = inputTimeMicros === undefined
        ? undefined
        : inputToPresentMicros(
          mainTimeOriginMillis,
          performance.timeOrigin,
          performance.now(),
          inputTimeMicros,
        );
      control.publish(
        tick,
        computeMicros,
        renderMicros,
        simulation.activeChunkCount,
        inputLatencyMicros,
      );
    }
    return {
      wakeSequence: input.wakeSequence,
      timeout: control.running ? Math.max(0, nextStepAt - performance.now()) : undefined,
    };
  };

  const waiter = AtomicInputAsyncWaiter.attach(input);
  while (true) {
    const waiting = runCycle();
    await waiter.waitForInput(waiting.wakeSequence, waiting.timeout);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
