import { ATOMIC_INPUT_KIND, AtomicInputBuffer } from "../atomic_input.ts";
import { writeDiscretePointerEventAt, writeLatestPointerEventAt } from "../atomic_input_dom.ts";
import { LIFE_COMMAND, LifeSharedBoard } from "../life_shared.ts";
import { SimdUi, type UiContainer, type UiDocument } from "../signals.ts";

const WIDTH = 256;
const HEIGHT = 160;
const TARGET_ID = 1;

export interface LifeDemoResult {
  readonly crossOriginIsolated: boolean;
  readonly cells: number;
  readonly generation: number;
  readonly liveCount: number;
  readonly droppedInputs: number;
  readonly stepMicros: number;
  readonly running: boolean;
}

export async function mountLifeDemo(
  host: HTMLElement,
  autorun: boolean,
): Promise<LifeDemoResult | null> {
  document.title = "Life, off the main thread — jsimd";
  document.body.classList.add("life-mode");
  const input = AtomicInputBuffer.create(256);
  const board = LifeSharedBoard.create(WIDTH, HEIGHT);
  const worker = new Worker(new URL("./life_worker.ts", import.meta.url), { type: "module" });
  const ui = new SimdUi({ document: document as unknown as UiDocument });
  const generation = ui.signal(0);
  const live = ui.signal(0);
  const stepMicros = ui.signal(0);
  const fps = ui.signal(0);
  const running = ui.signal(true);

  const root = ui.element("div", { className: "life-shell" }, [
    ui.element("header", { className: "life-hero" }, [
      ui.element("div", {}, [
        ui.element("p", { className: "eyebrow" }, ["jsimd × atomic input"]),
        ui.element("h1", {}, ["Life, off the main thread."]),
        ui.element("p", { className: "life-lead" }, [
          "40,960 cells evolve in a Worker. Dragging writes packed coordinates into shared memory; the main thread only paints completed frames.",
        ]),
      ]),
      ui.element("div", { className: "life-badge" }, [
        ui.element("span", {}, ["SHARED"]),
        ui.element("strong", {}, ["256 × 160"]),
        ui.element("small", {}, ["cells"]),
      ]),
    ]),
    ui.element("section", { className: "life-stage" }, [
      ui.element("div", { className: "life-canvas-frame" }, [
        ui.element("canvas", {
          id: "life-canvas",
          width: WIDTH,
          height: HEIGHT,
          ariaLabel: "Interactive Conway's Game of Life grid",
          tabIndex: 0,
        }),
        ui.element("div", { className: "life-overlay" }, [
          ui.element("span", { className: "life-status-dot" }),
          ui.text([running], () => running.value ? "RUNNING" : "PAUSED"),
        ]),
      ]),
      ui.element("aside", { className: "life-console" }, [
        ui.element("div", { className: "life-stats" }, [
          stat(ui, "publications", ui.text([generation], () => generation.value.toLocaleString())),
          stat(ui, "live cells", ui.text([live], () => live.value.toLocaleString())),
          stat(ui, "step", ui.text([stepMicros], () => `${stepMicros.value.toFixed(0)} µs`)),
          stat(ui, "paint", ui.text([fps], () => `${fps.value.toFixed(0)} fps`)),
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
      ui.element("span", {}, ["SIMD signal shell"]),
      ui.element("span", {}, ["Canvas snapshot"]),
    ]),
  ]);
  host.replaceChildren();
  await ui.mount(host as unknown as UiContainer, root);

  const canvas = required<HTMLCanvasElement>(host, "life-canvas");
  const context = canvas.getContext("2d", { alpha: false });
  if (context === null) throw new Error("2D canvas is unavailable");
  const image = context.createImageData(WIDTH, HEIGHT);
  const pixels = new Uint32Array(image.data.buffer);
  const snapshot = new Uint8Array(board.cellCount);
  const toggle = required<HTMLButtonElement>(host, "life-toggle");
  const stepButton = required<HTMLButtonElement>(host, "life-step");
  const rate = required<HTMLInputElement>(host, "life-rate");
  const rateValue = required<HTMLElement>(host, "life-rate-value");

  await requestReady(worker, input, board);
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
  let frames = 0;
  let fpsStarted = performance.now();
  const renderFrame = (): void => {
    running.value = board.running;
    const nextGeneration = board.generation;
    if (nextGeneration !== renderedGeneration && board.trySnapshotInto(snapshot)) {
      renderedGeneration = nextGeneration;
      for (let index = 0; index < snapshot.length; index++) {
        pixels[index] = snapshot[index] === 0 ? 0xff111a17 : 0xff9dff73;
      }
      context.putImageData(image, 0, 0);
      ui.batch(() => {
        generation.value = nextGeneration;
        live.value = board.liveCount;
        stepMicros.value = board.stepMicros;
      });
      frames++;
    }
    const now = performance.now();
    if (now - fpsStarted >= 500) {
      fps.value = frames * 1_000 / (now - fpsStarted);
      frames = 0;
      fpsStarted = now;
    }
    requestAnimationFrame(renderFrame);
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
  await waitFor(() => board.generation >= initialGeneration + 3, 3_000);
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
    stepMicros: board.stepMicros,
    running: board.running,
  };
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
): Promise<void> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (event) => {
      if (event.data?.type === "ready") resolve();
    };
    worker.onerror = (event) => reject(event.error ?? new Error(event.message));
    worker.postMessage({ type: "init", inputBuffer: input.buffer, boardBuffer: board.buffer });
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
