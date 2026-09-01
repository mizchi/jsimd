import { ATOMIC_INPUT_KIND, AtomicInputBuffer } from "../atomic_input.ts";
import { writeDiscretePointerEventAt, writeLatestPointerEventAt } from "../atomic_input_dom.ts";
import { summarizeSamples } from "../benchmark_stats.ts";
import {
  type LifeRenderer,
  type LifeRendererPreference,
  type LifeRuntime,
  selectLifeRenderer,
} from "../life_options.ts";
import { LIFE_COMMAND, LIFE_STATS_WORDS, LifeSharedBoard } from "../life_shared.ts";
import { SimdUi, type UiContainer, type UiDocument } from "../signals.ts";

const TARGET_ID = 1;

export interface LifeDemoResult {
  readonly crossOriginIsolated: boolean;
  readonly cells: number;
  readonly generation: number;
  readonly liveCount: number;
  readonly droppedInputs: number;
  readonly stepMicros: number;
  readonly running: boolean;
  readonly renderer: LifeRenderer;
  readonly rendererPreference: LifeRendererPreference;
  readonly runtime: LifeRuntime;
  readonly inputLatencyMs: number;
  readonly paintFps: number;
  readonly renderMicros: number;
  readonly frameGapP95Ms: number;
  readonly mainLoadMs: number;
  readonly computeBytes: number;
  readonly sharedBytes: number;
}

export async function mountLifeDemo(
  host: HTMLElement,
  autorun: boolean,
  runtime: LifeRuntime,
  width: number,
  height: number,
  rendererPreference: LifeRendererPreference,
  mainLoadMs: number,
): Promise<LifeDemoResult | null> {
  document.title = "Life, off the main thread — jsimd";
  document.body.classList.add("life-mode");
  const renderer = selectLifeRenderer(
    rendererPreference,
    width * height,
    typeof OffscreenCanvas !== "undefined" &&
      typeof HTMLCanvasElement.prototype.transferControlToOffscreen === "function",
  );
  const input = AtomicInputBuffer.create(256);
  const board = LifeSharedBoard.create(width, height, { cellSnapshots: renderer === "main" });
  const worker = new Worker(new URL("./life_worker.ts", import.meta.url), { type: "module" });
  const computeBytes = runtime === "simd"
    ? Math.ceil(board.cellCount * 2 / 65_536) * 65_536
    : board.cellCount * 2;
  const sharedBytes = board.buffer.byteLength + input.buffer.byteLength;
  const ui = new SimdUi({ document: document as unknown as UiDocument });
  const generation = ui.signal(0);
  const live = ui.signal(0);
  const stepMedianMicros = ui.signal(0);
  const renderMedianMicros = ui.signal(0);
  const fps = ui.signal(0);
  const frameGapP95Ms = ui.signal(0);
  const inputLatencyMs = ui.signal(0);
  const running = ui.signal(true);

  const root = ui.element("div", { className: "life-shell" }, [
    ui.element("header", { className: "life-hero" }, [
      ui.element("div", {}, [
        ui.element("p", { className: "eyebrow" }, ["jsimd × atomic input"]),
        ui.element("h1", {}, ["Life, off the main thread."]),
        ui.element("p", { className: "life-lead" }, [
          `${board.cellCount.toLocaleString()} cells evolve in a Worker. Switch between scalar JavaScript and a 16-cell Wasm SIMD kernel without changing the UI pipeline.`,
        ]),
      ]),
      ui.element("div", { className: "life-badge" }, [
        ui.element("span", {}, ["KERNEL"]),
        ui.element("strong", {}, [runtime === "simd" ? "WASM SIMD" : "SCALAR JS"]),
        ui.element("small", {}, [`${width} × ${height} cells`]),
      ]),
    ]),
    ui.element("section", { className: "life-stage" }, [
      ui.element("div", { className: "life-canvas-frame" }, [
        ui.element("canvas", {
          id: "life-canvas",
          width,
          height,
          ariaLabel: "Interactive Conway's Game of Life grid",
          tabIndex: 0,
        }),
        ui.element("div", { className: "life-overlay" }, [
          ui.element("span", { className: "life-status-dot" }),
          ui.text([running], () => running.value ? "RUNNING" : "PAUSED"),
        ]),
      ]),
      ui.element("aside", { className: "life-console" }, [
        ui.element("nav", { className: "life-runtime", ariaLabel: "Life compute runtime" }, [
          ui.element("a", {
            href: lifeHref("simd", width, rendererPreference),
            className: runtime === "simd" ? "active" : "",
          }, ["Wasm SIMD"]),
          ui.element("a", {
            href: lifeHref("scalar", width, rendererPreference),
            className: runtime === "scalar" ? "active" : "",
          }, ["Scalar JS"]),
        ]),
        ui.element("nav", { className: "life-size", ariaLabel: "Life grid size" }, [
          ...[256, 512, 1_024].map((candidate) =>
            ui.element("a", {
              href: lifeHref(runtime, candidate, rendererPreference),
              className: width === candidate ? "active" : "",
            }, [`${candidate}×${candidate * 5 / 8}`])
          ),
        ]),
        ui.element("nav", { className: "life-renderer", ariaLabel: "Life canvas renderer" }, [
          ui.element("a", {
            href: lifeHref(runtime, width, "auto"),
            className: rendererPreference === "auto" ? "active" : "",
          }, [`Auto → ${renderer === "offscreen" ? "Worker" : "Main"}`]),
          ui.element("a", {
            href: lifeHref(runtime, width, "offscreen"),
            className: rendererPreference === "offscreen" ? "active" : "",
          }, ["Worker canvas"]),
          ui.element("a", {
            href: lifeHref(runtime, width, "main"),
            className: rendererPreference === "main" ? "active" : "",
          }, ["Main canvas"]),
        ]),
        ui.element("div", { className: "life-stats" }, [
          stat(ui, "publications", ui.text([generation], () => generation.value.toLocaleString())),
          stat(ui, "live cells", ui.text([live], () => live.value.toLocaleString())),
          stat(
            ui,
            "step median",
            ui.text([stepMedianMicros], () => `${stepMedianMicros.value.toFixed(0)} µs`),
          ),
          stat(ui, "paint", ui.text([fps], () => `${fps.value.toFixed(0)} fps`)),
          stat(
            ui,
            "rAF gap p95",
            ui.text([frameGapP95Ms], () => `${frameGapP95Ms.value.toFixed(1)} ms`),
          ),
          stat(ui, "main load", ui.text([], () => `${mainLoadMs} ms/rAF`)),
          stat(
            ui,
            "render median",
            ui.text([renderMedianMicros], () => `${renderMedianMicros.value.toFixed(0)} µs`),
          ),
          stat(
            ui,
            "input → frame",
            ui.text([inputLatencyMs], () => `${inputLatencyMs.value.toFixed(1)} ms`),
          ),
          stat(ui, "compute memory", ui.text([], () => formatBytes(computeBytes))),
          stat(ui, "shared memory", ui.text([], () => formatBytes(sharedBytes))),
        ]),
        ui.element("div", { className: "life-controls" }, [
          ui.element("button", { id: "life-toggle", className: "life-primary" }, [
            ui.text([running], () => running.value ? "Pause" : "Play"),
          ]),
          ui.element("button", { id: "life-step" }, ["Step"]),
          ui.element("button", { id: "life-randomize" }, ["Randomize"]),
          ui.element("button", { id: "life-clear" }, ["Clear"]),
        ]),
        ui.element("label", { className: "life-rate" }, [
          ui.element("span", {}, ["Simulation rate"]),
          ui.element("strong", { id: "life-rate-value" }, ["30 Hz"]),
          ui.element("input", {
            id: "life-rate",
            type: "range",
            min: 1,
            max: 60,
            value: 30,
          }),
        ]),
        ui.element("p", { className: "life-hint" }, [
          "Drag to seed life. Shift-drag or right-drag to erase. Pointer moves are coalesced; lines are reconstructed in the Worker.",
        ]),
      ]),
    ]),
    ui.element("footer", { className: "life-footer" }, [
      ui.element("span", {}, ["SharedArrayBuffer"]),
      ui.element("span", {}, ["Atomics.wait / notify"]),
      ui.element("span", {}, [runtime === "simd" ? "i8x16 Life kernel" : "Scalar baseline"]),
      ui.element("span", {}, [renderer === "offscreen" ? "OffscreenCanvas" : "Main canvas"]),
    ]),
  ]);
  host.replaceChildren();
  await ui.mount(host as unknown as UiContainer, root);

  const canvas = required<HTMLCanvasElement>(host, "life-canvas");
  const context = renderer === "main" ? canvas.getContext("2d", { alpha: false }) : null;
  if (renderer === "main" && context === null) throw new Error("2D canvas is unavailable");
  if (renderer === "offscreen" && typeof canvas.transferControlToOffscreen !== "function") {
    throw new Error("OffscreenCanvas is unavailable");
  }
  const image = context?.createImageData(width, height) ?? null;
  const pixels = image === null ? null : new Uint32Array(image.data.buffer);
  const snapshot = renderer === "main" ? new Uint8Array(board.cellCount) : null;
  const stats = new Int32Array(LIFE_STATS_WORDS);
  const toggle = required<HTMLButtonElement>(host, "life-toggle");
  const stepButton = required<HTMLButtonElement>(host, "life-step");
  const rate = required<HTMLInputElement>(host, "life-rate");
  const rateValue = required<HTMLElement>(host, "life-rate-value");

  const offscreen = renderer === "offscreen" ? canvas.transferControlToOffscreen() : undefined;
  await requestReady(worker, input, board, runtime, renderer, offscreen);
  const updateViewport = (): void => {
    board.setViewportFixed(
      0,
      0,
      Math.round(canvas.clientWidth * 64),
      Math.round(canvas.clientHeight * 64),
    );
  };
  updateViewport();
  const resizeObserver = new ResizeObserver(updateViewport);
  resizeObserver.observe(canvas);

  canvas.addEventListener("pointermove", (event) => {
    writeLatestPointerEventAt(
      input,
      ATOMIC_INPUT_KIND.pointerMove,
      TARGET_ID,
      event.offsetX,
      event.offsetY,
      event,
    );
  });
  canvas.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    if (event.isTrusted) canvas.setPointerCapture(event.pointerId);
    writeDiscretePointerEventAt(
      input,
      ATOMIC_INPUT_KIND.pointerDown,
      TARGET_ID,
      event.offsetX,
      event.offsetY,
      event,
    );
  });
  canvas.addEventListener("pointerup", (event) => {
    writeDiscretePointerEventAt(
      input,
      ATOMIC_INPUT_KIND.pointerUp,
      TARGET_ID,
      event.offsetX,
      event.offsetY,
      event,
    );
  });
  canvas.addEventListener("pointercancel", (event) => {
    writeDiscretePointerEventAt(
      input,
      ATOMIC_INPUT_KIND.pointerCancel,
      TARGET_ID,
      event.offsetX,
      event.offsetY,
      event,
    );
  });
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());

  const command = (value: (typeof LIFE_COMMAND)[keyof typeof LIFE_COMMAND]): void => {
    board.issueCommand(value);
    input.wake();
  };
  toggle.addEventListener("click", () => command(LIFE_COMMAND.toggleRunning));
  stepButton.addEventListener("click", () => command(LIFE_COMMAND.step));
  required(host, "life-randomize").addEventListener("click", () => command(LIFE_COMMAND.randomize));
  required(host, "life-clear").addEventListener("click", () => command(LIFE_COMMAND.clear));
  rate.addEventListener("input", () => {
    board.setRate(rate.valueAsNumber);
    rateValue.textContent = `${board.rate} Hz`;
    input.wake();
  });

  let renderedGeneration = -1;
  let renderedInputSequence = 0;
  let frames = 0;
  let fpsStarted = performance.now();
  let previousFrameAt = 0;
  const stepSamples: number[] = [];
  const renderSamples: number[] = [];
  const inputLatencySamples: number[] = [];
  const frameGapSamples: number[] = [];
  const renderFrame = (): void => {
    const frameStarted = performance.now();
    if (previousFrameAt > 0) appendSample(frameGapSamples, frameStarted - previousFrameAt);
    previousFrameAt = frameStarted;
    burnMainThread(mainLoadMs);
    running.value = board.running;
    if (board.tryStatsInto(stats)) {
      const nextGeneration = stats[0]! >>> 0;
      if (nextGeneration === renderedGeneration) {
        updateFps();
        requestAnimationFrame(renderFrame);
        return;
      }
      let renderMicros = stats[6]! >>> 0;
      if (renderer === "main") {
        if (
          snapshot === null || context === null || image === null || pixels === null ||
          !board.trySnapshotInto(snapshot)
        ) {
          requestAnimationFrame(renderFrame);
          return;
        }
        const renderStarted = performance.now();
        for (let index = 0; index < snapshot.length; index++) {
          pixels[index] = snapshot[index] === 0 ? 0xff111a17 : 0xff9dff73;
        }
        context.putImageData(image, 0, 0);
        renderMicros = (performance.now() - renderStarted) * 1_000;
      }
      renderedGeneration = nextGeneration;
      ui.batch(() => {
        generation.value = nextGeneration;
        live.value = stats[1]! >>> 0;
        const nextStepMicros = stats[2]! >>> 0;
        if (nextStepMicros > 0) {
          appendSample(stepSamples, nextStepMicros);
          stepMedianMicros.value = median(stepSamples);
        }
        if (renderMicros > 0) {
          appendSample(renderSamples, renderMicros);
          renderMedianMicros.value = median(renderSamples);
        }
        const inputSequence = stats[5]! >>> 0;
        if (inputSequence !== renderedInputSequence) {
          renderedInputSequence = inputSequence;
          const nowMicros = Math.round(performance.now() * 1_000) >>> 0;
          appendSample(inputLatencySamples, ((nowMicros - (stats[4]! >>> 0)) >>> 0) / 1_000);
          inputLatencyMs.value = median(inputLatencySamples);
        }
      });
      frames++;
    }
    updateFps();
    requestAnimationFrame(renderFrame);
  };
  const updateFps = (): void => {
    const now = performance.now();
    if (now - fpsStarted < 500) return;
    fps.value = frames * 1_000 / (now - fpsStarted);
    if (frameGapSamples.length > 0) frameGapP95Ms.value = summarizeSamples(frameGapSamples).p95;
    frames = 0;
    fpsStarted = now;
  };
  requestAnimationFrame(renderFrame);

  if (!autorun) return null;
  const rect = canvas.getBoundingClientRect();
  canvas.dispatchEvent(
    pointer("pointerdown", rect.left + rect.width * 0.2, rect.top + rect.height * 0.25, 1),
  );
  for (let index = 1; index <= 20; index++) {
    canvas.dispatchEvent(pointer(
      "pointermove",
      rect.left + rect.width * (0.2 + index * 0.025),
      rect.top + rect.height * (0.25 + index * 0.02),
      1,
    ));
  }
  canvas.dispatchEvent(
    pointer("pointerup", rect.left + rect.width * 0.7, rect.top + rect.height * 0.65, 0),
  );
  const initialGeneration = board.generation;
  await waitFor(() => board.generation >= initialGeneration + 20, 4_000);
  for (let sample = 0; sample < 11; sample++) {
    const inputSequence = board.inputSequence;
    const x = rect.left + rect.width * (0.15 + sample * 0.06);
    const y = rect.top + rect.height * (0.72 - sample * 0.025);
    canvas.dispatchEvent(pointer("pointerdown", x, y, 1));
    canvas.dispatchEvent(pointer("pointerup", x, y, 0));
    await waitFor(() => board.inputSequence !== inputSequence, 1_000);
    await waitFor(() => renderedInputSequence === board.inputSequence, 1_000);
  }
  toggle.click();
  await waitFor(() => !board.running, 3_000);
  const pausedGeneration = board.generation;
  stepButton.click();
  await waitFor(() => board.generation > pausedGeneration, 3_000);
  toggle.click();
  await waitFor(() => board.running, 3_000);
  return {
    crossOriginIsolated,
    cells: board.cellCount,
    generation: board.generation,
    liveCount: board.liveCount,
    droppedInputs: input.droppedCount,
    stepMicros: stepMedianMicros.value,
    running: board.running,
    renderer,
    rendererPreference,
    runtime,
    inputLatencyMs: inputLatencyMs.value,
    paintFps: fps.value,
    renderMicros: renderMedianMicros.value,
    frameGapP95Ms: frameGapP95Ms.value,
    mainLoadMs,
    computeBytes,
    sharedBytes,
  };
}

function lifeHref(
  runtime: LifeRuntime,
  width: number,
  renderer: LifeRendererPreference,
): string {
  return `?run=life&runtime=${runtime}&size=${width}&renderer=${renderer}`;
}

function appendSample(samples: number[], value: number): void {
  samples.push(value);
  if (samples.length > 120) samples.shift();
}

function burnMainThread(milliseconds: number): void {
  if (milliseconds <= 0) return;
  const deadline = performance.now() + milliseconds;
  while (performance.now() < deadline) {
    // Intentionally model unrelated application work in the benchmark fixture.
  }
}

function median(values: readonly number[]): number {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function formatBytes(bytes: number): string {
  return bytes < 1_048_576
    ? `${(bytes / 1_024).toFixed(0)} KiB`
    : `${(bytes / 1_048_576).toFixed(2)} MiB`;
}

function stat(ui: SimdUi, label: string, value: ReturnType<SimdUi["text"]>) {
  return ui.element("div", {}, [
    ui.element("span", {}, [label]),
    ui.element("strong", {}, [value]),
  ]);
}

function required<T extends HTMLElement = HTMLElement>(host: HTMLElement, id: string): T {
  const element = host.querySelector(`#${id}`);
  if (!(element instanceof HTMLElement)) throw new Error(`#${id} is required`);
  return element as T;
}

function requestReady(
  worker: Worker,
  input: AtomicInputBuffer,
  board: LifeSharedBoard,
  runtime: LifeRuntime,
  renderer: LifeRenderer,
  canvas?: OffscreenCanvas,
): Promise<void> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (event) => {
      if (event.data?.type === "ready") resolve();
    };
    worker.onerror = (event) => reject(event.error ?? new Error(event.message));
    const message = {
      type: "init",
      inputBuffer: input.buffer,
      boardBuffer: board.buffer,
      runtime,
      renderer,
      canvas,
    };
    worker.postMessage(message, canvas === undefined ? [] : [canvas]);
  });
}

function pointer(type: string, clientX: number, clientY: number, buttons: number): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    clientX,
    clientY,
    pointerId: 91,
    buttons,
    button: 0,
    pressure: buttons === 0 ? 0 : 0.5,
  });
}

async function waitFor(predicate: () => boolean, timeout: number): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("life demo timed out");
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
}
