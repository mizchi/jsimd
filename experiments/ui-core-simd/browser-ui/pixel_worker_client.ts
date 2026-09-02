import { ATOMIC_INPUT_KIND, AtomicInputBuffer } from "../atomic_input.ts";
import { writeDiscretePointerEventAt, writeLatestPointerEventAt } from "../atomic_input_dom.ts";
import type { PixelRegion } from "../pixel_options.ts";
import type { PixelMaterial } from "../pixel_sim.ts";
import { PIXEL_WORKER_STATS_WORDS, PixelWorkerControl } from "../pixel_worker_control.ts";
import type { PixelWorkerInitMessage } from "./pixel_worker_runtime.ts";

const TARGET_ID = 2;
export type PixelWorkerBackendKind = "active" | "active-simd";

export class PixelWorkerClient {
  readonly input: AtomicInputBuffer;
  readonly control: PixelWorkerControl;
  readonly stats = new Int32Array(PIXEL_WORKER_STATS_WORDS);
  readonly chunkCount: number;
  readonly residentBytes: number;
  readonly #worker: Worker;
  readonly #canvas: HTMLCanvasElement;
  readonly #resizeObserver: ResizeObserver;

  private constructor(
    canvas: HTMLCanvasElement,
    worker: Worker,
    input: AtomicInputBuffer,
    control: PixelWorkerControl,
    resizeObserver: ResizeObserver,
    backend: PixelWorkerBackendKind,
  ) {
    this.#canvas = canvas;
    this.#worker = worker;
    this.input = input;
    this.control = control;
    this.#resizeObserver = resizeObserver;
    const chunksX = Math.ceil(control.width / 32);
    const chunksY = Math.ceil(control.height / 32);
    this.chunkCount = chunksX * chunksY;
    const cellBytes = control.width * control.height * Uint32Array.BYTES_PER_ELEMENT;
    const simulationBytes = backend === "active-simd"
      ? Math.max(65_536, Math.ceil(cellBytes / 65_536) * 65_536)
      : cellBytes;
    this.residentBytes = simulationBytes + cellBytes + this.chunkCount * 3 +
      control.buffer.byteLength + this.input.buffer.byteLength;
  }

  static async create(
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
    occupancy: number,
    region: PixelRegion,
    backend: PixelWorkerBackendKind = "active",
  ): Promise<PixelWorkerClient> {
    if (typeof canvas.transferControlToOffscreen !== "function") {
      throw new Error("OffscreenCanvas is unavailable");
    }
    const control = PixelWorkerControl.create(width, height);
    const input = AtomicInputBuffer.create(256);
    const worker = backend === "active-simd"
      ? new Worker(new URL("./pixel_block_active_simd_worker.ts", import.meta.url), {
        type: "module",
      })
      : new Worker(new URL("./pixel_worker.ts", import.meta.url), { type: "module" });
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
    const client = new PixelWorkerClient(canvas, worker, input, control, resizeObserver, backend);
    const offscreen = canvas.transferControlToOffscreen();
    try {
      await requestReady(worker, {
        type: "init",
        inputBuffer: input.buffer,
        controlBuffer: control.buffer,
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

  pointerDown(event: PointerEvent): void {
    const point = this.#localPoint(event);
    writeDiscretePointerEventAt(
      this.input,
      ATOMIC_INPUT_KIND.pointerDown,
      TARGET_ID,
      point.x,
      point.y,
      event,
    );
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
    const point = this.#localPoint(event);
    writeDiscretePointerEventAt(
      this.input,
      ATOMIC_INPUT_KIND.pointerUp,
      TARGET_ID,
      point.x,
      point.y,
      event,
    );
  }

  pointerCancel(event: PointerEvent): void {
    const point = this.#localPoint(event);
    writeDiscretePointerEventAt(
      this.input,
      ATOMIC_INPUT_KIND.pointerCancel,
      TARGET_ID,
      point.x,
      point.y,
      event,
    );
  }

  dispose(): void {
    this.#resizeObserver.disconnect();
    this.#worker.terminate();
  }

  #localPoint(event: PointerEvent): { readonly x: number; readonly y: number } {
    const rect = this.#canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
}

function requestReady(
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
