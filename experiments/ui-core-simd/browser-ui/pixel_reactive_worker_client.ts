import { ATOMIC_INPUT_KIND, AtomicInputBuffer } from "../atomic_input.ts";
import { writeDiscretePointerEventAt, writeLatestPointerEventAt } from "../atomic_input_dom.ts";
import { PIXEL_EVENT_RECORD_WORDS, PixelEventTape } from "../pixel_event_tape.ts";
import type { PixelRegion } from "../pixel_options.ts";
import { pixelReactionRequiredBytes } from "../pixel_reaction_layout.ts";
import type { PixelMaterial } from "../pixel_sim.ts";
import { PIXEL_WORKER_STATS_WORDS, PixelWorkerControl } from "../pixel_worker_control.ts";
import { elapsedUint32Micros, timelineMicros } from "../pixel_worker_timing.ts";
import type { PixelWorkerInitMessage } from "./pixel_worker_runtime.ts";

const TARGET_ID = 2;
const EVENT_CAPACITY = 256;

export class PixelReactiveWorkerClient {
  readonly input: AtomicInputBuffer;
  readonly control: PixelWorkerControl;
  readonly events: PixelEventTape;
  readonly stats = new Int32Array(PIXEL_WORKER_STATS_WORDS);
  readonly eventRecords = new Int32Array(EVENT_CAPACITY * PIXEL_EVENT_RECORD_WORDS);
  readonly chunkCount: number;
  readonly residentBytes: number;
  readonly #worker: Worker;
  readonly #canvas: HTMLCanvasElement;
  readonly #resizeObserver: ResizeObserver;
  #eventLatencyMs = 0;

  private constructor(
    canvas: HTMLCanvasElement,
    worker: Worker,
    input: AtomicInputBuffer,
    control: PixelWorkerControl,
    events: PixelEventTape,
    resizeObserver: ResizeObserver,
  ) {
    this.#canvas = canvas;
    this.#worker = worker;
    this.input = input;
    this.control = control;
    this.events = events;
    this.#resizeObserver = resizeObserver;
    const chunksX = Math.ceil(control.width / 32);
    const chunksY = Math.ceil(control.height / 32);
    this.chunkCount = chunksX * chunksY;
    const cellBytes = control.width * control.height * Uint32Array.BYTES_PER_ELEMENT;
    const reactionBytes = pixelReactionRequiredBytes(control.width, control.height, EVENT_CAPACITY);
    const simulationBytes = Math.max(65_536, Math.ceil(reactionBytes / 65_536) * 65_536);
    this.residentBytes = simulationBytes + cellBytes + this.chunkCount * 3 +
      control.buffer.byteLength + input.buffer.byteLength + events.buffer.byteLength;
  }

  static async create(
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
    occupancy: number,
    region: PixelRegion,
  ): Promise<PixelReactiveWorkerClient> {
    if (typeof canvas.transferControlToOffscreen !== "function") {
      throw new Error("OffscreenCanvas is unavailable");
    }
    const control = PixelWorkerControl.create(width, height);
    const input = AtomicInputBuffer.create(256);
    const events = PixelEventTape.create(EVENT_CAPACITY);
    const worker = new Worker(new URL("./pixel_reactive_simd_worker.ts", import.meta.url), {
      type: "module",
    });
    const updateViewport = (): void => {
      control.setViewportFixed(
        0,
        0,
        Math.round(canvas.clientWidth * 64),
        Math.round(canvas.clientHeight * 64),
      );
    };
    updateViewport();
    const resizeObserver = new ResizeObserver(updateViewport);
    resizeObserver.observe(canvas);
    const client = new PixelReactiveWorkerClient(
      canvas,
      worker,
      input,
      control,
      events,
      resizeObserver,
    );
    const offscreen = canvas.transferControlToOffscreen();
    try {
      await requestPixelWorkerReady(worker, {
        type: "init",
        inputBuffer: input.buffer,
        controlBuffer: control.buffer,
        eventBuffer: events.buffer,
        canvas: offscreen,
        occupancy,
        region,
        mainTimeOriginMillis: performance.timeOrigin,
      }, offscreen);
      return client;
    } catch (error) {
      client.dispose();
      throw error;
    }
  }

  get running(): boolean {
    return this.control.running;
  }

  setMaterial(material: PixelMaterial): void {
    this.control.brushMaterial = material;
    this.input.wake();
  }

  toggleRunning(): boolean {
    this.control.running = !this.control.running;
    this.input.wake();
    return this.control.running;
  }

  readStats(): boolean {
    return this.control.tryStatsInto(this.stats);
  }
  drainEvents(): number {
    const count = this.events.drainInto(this.eventRecords);
    if (count > 0) {
      const consumed = timelineMicros(performance.timeOrigin, performance.now());
      this.#eventLatencyMs = elapsedUint32Micros(consumed, this.events.publishedMicros) / 1_000;
    }
    return count;
  }
  get eventLatencyMs(): number {
    return this.#eventLatencyMs;
  }
  get droppedEvents(): number {
    return this.events.droppedCount;
  }
  pointerDown(event: PointerEvent): void {
    this.#writeDiscrete(ATOMIC_INPUT_KIND.pointerDown, event);
  }

  pointerMove(event: PointerEvent): void {
    const point = this.#localPoint(event);
    writeLatestPointerEventAt(
      this.input,
      ATOMIC_INPUT_KIND.pointerMove,
      TARGET_ID,
      point.x,
      point.y,
      event,
    );
  }

  pointerUp(event: PointerEvent): void {
    this.#writeDiscrete(ATOMIC_INPUT_KIND.pointerUp, event);
  }
  pointerCancel(event: PointerEvent): void {
    this.#writeDiscrete(ATOMIC_INPUT_KIND.pointerCancel, event);
  }

  dispose(): void {
    this.#resizeObserver.disconnect();
    this.#worker.terminate();
  }

  #writeDiscrete(kind: 1 | 3 | 4, event: PointerEvent): void {
    const point = this.#localPoint(event);
    writeDiscretePointerEventAt(this.input, kind, TARGET_ID, point.x, point.y, event);
  }

  #localPoint(event: PointerEvent): { readonly x: number; readonly y: number } {
    const rect = this.#canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
}

function requestPixelWorkerReady(
  worker: Worker,
  message: PixelWorkerInitMessage,
  canvas: OffscreenCanvas,
): Promise<void> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (event) => {
      if (event.data?.type === "ready") resolve();
      if (event.data?.type === "error") reject(new Error(event.data.message));
    };
    worker.onerror = (event) => reject(event.error ?? new Error(event.message));
    worker.postMessage(message, [canvas]);
  });
}
