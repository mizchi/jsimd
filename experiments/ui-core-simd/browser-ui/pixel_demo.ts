import { summarizeSamples } from "../benchmark_stats.ts";
import type { PixelRegion, PixelRuntime } from "../pixel_options.ts";
import {
  createPixelScenario,
  MATERIAL,
  paintPixelCircle,
  type PixelMaterial,
  pixelMaterial,
  stepPixelWorld,
} from "../pixel_sim.ts";
import { SimdUi, type UiContainer, type UiDocument } from "../signals.ts";
import type { WebGpuPixelSimulation } from "./pixel_webgpu.ts";
import type { ActivePixelSimulation } from "./pixel_active_runtime.ts";
import type { PixelWorkerClient } from "./pixel_worker_client.ts";

const MATERIAL_COLORS = [0xff15100c, 0xff615950, 0xff3db0f0, 0xffe88c2e] as const;

export interface PixelDemoResult {
  readonly runtime: PixelRuntime;
  readonly cells: number;
  readonly occupancy: number;
  readonly region: PixelRegion;
  readonly ticks: number;
  readonly tickMedianMs: number;
  readonly tickP95Ms: number;
  readonly computeMedianMs: number;
  readonly renderMedianMs: number;
  readonly inputLatencyMs: number;
  readonly frameGapP95Ms: number;
  readonly mainFrameMedianMs: number;
  readonly paintFps: number;
  readonly residentBytes: number;
  readonly adapter: string;
  readonly mainLoadMs: number;
  readonly activeChunks: number;
  readonly chunkCount: number;
}

interface PendingBrush {
  readonly x: number;
  readonly y: number;
  readonly material: PixelMaterial;
  readonly at: number;
}

export async function mountPixelDemo(
  host: HTMLElement,
  autorun: boolean,
  runtime: PixelRuntime,
  width: number,
  height: number,
  occupancy: number,
  region: PixelRegion,
  mainLoadMs: number,
): Promise<PixelDemoResult | null> {
  document.title = "Pixel Lab — jsimd";
  document.body.classList.add("life-mode", "pixel-mode");
  const ui = new SimdUi({ document: document as unknown as UiDocument });
  const running = ui.signal(true);
  const tickCount = ui.signal(0);
  const tickMedian = ui.signal(0);
  const computeMedian = ui.signal(0);
  const renderMedian = ui.signal(0);
  const fps = ui.signal(0);
  const frameGapP95 = ui.signal(0);
  const mainFrameMedian = ui.signal(0);
  const inputLatency = ui.signal(0);
  const activeChunkCount = ui.signal(0);
  const selectedMaterial = ui.signal<PixelMaterial>(MATERIAL.sand);
  const backend = ui.signal(
    runtime === "webgpu"
      ? "initializing WebGPU…"
      : runtime === "worker"
      ? "initializing Worker…"
      : runtime === "active"
      ? "active-chunk CPU"
      : "scalar CPU",
  );
  const occupancyPercent = Math.round(occupancy * 100);

  const root = ui.element("div", { className: "life-shell pixel-shell" }, [
    ui.element("header", { className: "life-hero" }, [
      ui.element("div", {}, [
        ui.element("p", { className: "eyebrow" }, ["jsimd × material cellular automata"]),
        ui.element("h1", {}, ["Pixel Lab"]),
        ui.element("p", { className: "life-lead" }, [
          "The same conservative material rules run as full CPU, sparse active chunks, off-thread canvas, or disjoint WebGPU passes.",
        ]),
      ]),
      ui.element("div", { className: "life-badge pixel-badge" }, [
        ui.element("span", {}, ["BACKEND"]),
        ui.element("strong", {}, [
          runtime === "webgpu"
            ? "WEBGPU"
            : runtime === "worker"
            ? "WORKER CPU"
            : runtime === "active"
            ? "ACTIVE CPU"
            : "CPU",
        ]),
        ui.element("small", {}, [
          `${width} × ${height} · ${occupancyPercent}% · ${region}`,
        ]),
      ]),
    ]),
    ui.element("section", { className: "life-stage" }, [
      ui.element("div", { className: "life-canvas-frame pixel-canvas-frame" }, [
        ui.element("canvas", {
          id: "pixel-canvas",
          width,
          height,
          ariaLabel: "Interactive falling sand and water simulation",
          tabIndex: 0,
        }),
        ui.element("div", { className: "life-overlay" }, [
          ui.element("span", { className: "life-status-dot" }),
          ui.text([running], () => running.value ? "RUNNING" : "PAUSED"),
        ]),
      ]),
      ui.element("aside", { className: "life-console" }, [
        ui.element("nav", {
          className: "life-runtime pixel-runtime",
          ariaLabel: "Pixel simulation runtime",
        }, [
          ui.element("a", {
            href: pixelHref("cpu", width, occupancyPercent, region),
            className: runtime === "cpu" ? "active" : "",
          }, ["Scalar CPU"]),
          ui.element("a", {
            href: pixelHref("active", width, occupancyPercent, region),
            className: runtime === "active" ? "active" : "",
          }, ["Active CPU"]),
          ui.element("a", {
            href: pixelHref("worker", width, occupancyPercent, region),
            className: runtime === "worker" ? "active" : "",
          }, ["Worker CPU"]),
          ui.element("a", {
            href: pixelHref("webgpu", width, occupancyPercent, region),
            className: runtime === "webgpu" ? "active" : "",
          }, ["WebGPU"]),
        ]),
        ui.element("nav", { className: "life-size", ariaLabel: "Pixel world size" }, [
          ...[256, 512, 1_024].map((candidate) =>
            ui.element("a", {
              href: pixelHref(runtime, candidate, occupancyPercent, region),
              className: width === candidate ? "active" : "",
            }, [`${candidate}×${candidate * 5 / 8}`])
          ),
        ]),
        ui.element("nav", { className: "life-size", ariaLabel: "Initial occupancy" }, [
          ...[5, 25, 75].map((candidate) =>
            ui.element("a", {
              href: pixelHref(runtime, width, candidate, region),
              className: occupancyPercent === candidate ? "active" : "",
            }, [`${candidate}%`])
          ),
        ]),
        ui.element("nav", { className: "life-size", ariaLabel: "Initial active region" }, [
          ...(["full", "quarter", "spot"] as const).map((candidate) =>
            ui.element("a", {
              href: pixelHref(runtime, width, occupancyPercent, candidate),
              className: region === candidate ? "active" : "",
            }, [candidate])
          ),
        ]),
        ui.element("div", { className: "life-stats" }, [
          stat(ui, "ticks", ui.text([tickCount], () => tickCount.value.toLocaleString())),
          stat(
            ui,
            "tick + present",
            ui.text([tickMedian], () => `${tickMedian.value.toFixed(2)} ms`),
          ),
          stat(
            ui,
            "render CPU",
            ui.text([renderMedian], () => `${renderMedian.value.toFixed(2)} ms`),
          ),
          stat(
            ui,
            "compute CPU",
            ui.text([computeMedian], () => `${computeMedian.value.toFixed(2)} ms`),
          ),
          stat(ui, "paint", ui.text([fps], () => `${fps.value.toFixed(0)} fps`)),
          stat(
            ui,
            "rAF gap p95",
            ui.text([frameGapP95], () => `${frameGapP95.value.toFixed(1)} ms`),
          ),
          stat(
            ui,
            "main frame work",
            ui.text([mainFrameMedian], () => `${mainFrameMedian.value.toFixed(2)} ms`),
          ),
          stat(
            ui,
            "input → present",
            ui.text([inputLatency], () => `${inputLatency.value.toFixed(1)} ms`),
          ),
          stat(ui, "main load", ui.text([], () => `${mainLoadMs} ms/rAF`)),
          stat(ui, "backend", ui.text([backend], () => backend.value)),
          stat(
            ui,
            "active chunks",
            ui.text([activeChunkCount], () => activeChunkCount.value.toLocaleString()),
          ),
        ]),
        ui.element("div", { className: "life-controls pixel-materials" }, [
          ui.element("button", { id: "pixel-sand", className: "life-primary" }, ["Sand"]),
          ui.element("button", { id: "pixel-water" }, ["Water"]),
          ui.element("button", { id: "pixel-wall" }, ["Wall"]),
          ui.element("button", { id: "pixel-erase" }, ["Erase"]),
        ]),
        ui.element("div", { className: "life-controls" }, [
          ui.element("button", { id: "pixel-toggle", className: "life-primary" }, [
            ui.text([running], () => running.value ? "Pause" : "Play"),
          ]),
          ui.element("a", {
            className: "pixel-life-link",
            href: "?run=life&runtime=simd&renderer=auto",
          }, ["Life baseline"]),
        ]),
        ui.element("p", { className: "life-hint" }, [
          ui.text(
            [selectedMaterial],
            () =>
              `Brush: ${
                materialName(selectedMaterial.value)
              }. Drag on the world; ${
                runtime === "worker"
                  ? "Atomics coalesces moves and the Worker reconstructs the stroke."
                  : "input is coalesced to one GPU/CPU brush per presented frame."
              }`,
          ),
        ]),
      ]),
    ]),
    ui.element("footer", { className: "life-footer" }, [
      ui.element("span", {}, ["u32 material ABI"]),
      ui.element("span", {}, ["conservative pair swaps"]),
      ui.element("span", {}, ["vertical / diagonal / horizontal"]),
      ui.element("span", {}, [
        runtime === "webgpu"
          ? "zero readback"
          : runtime === "worker"
          ? "Atomics + OffscreenCanvas"
          : "ImageData present",
      ]),
    ]),
  ]);
  host.replaceChildren();
  await ui.mount(host as unknown as UiContainer, root);

  const canvas = required<HTMLCanvasElement>(host, "pixel-canvas");
  const cells = runtime === "worker"
    ? null
    : createPixelScenario(width, height, occupancy, 0x51f1_5e5d, region);
  let active: ActivePixelSimulation | null = null;
  if (runtime === "active") {
    const module = await import("./pixel_active_runtime.ts");
    active = module.ActivePixelSimulation.create(cells!, width, height);
    activeChunkCount.value = active.activeChunkCount;
  }
  let gpu: WebGpuPixelSimulation | null = null;
  let context: CanvasRenderingContext2D | null = null;
  let image: ImageData | null = null;
  let pixels: Uint32Array | null = null;
  let workerClient: PixelWorkerClient | null = null;
  if (runtime === "worker") {
    const module = await import("./pixel_worker_client.ts");
    workerClient = await module.PixelWorkerClient.create(
      canvas,
      width,
      height,
      occupancy,
      region,
    );
    backend.value = "active-chunk Worker";
    activeChunkCount.value = workerClient.stats[3]! >>> 0;
  } else if (runtime === "webgpu") {
    const module = await import("./pixel_webgpu.ts");
    gpu = await module.WebGpuPixelSimulation.create(canvas, cells!, width, height);
    backend.value = adapterLabel(gpu.adapterInfo);
  } else {
    context = canvas.getContext("2d", { alpha: false });
    if (context === null) throw new Error("2D canvas is unavailable");
    image = context.createImageData(width, height);
    pixels = new Uint32Array(image.data.buffer);
    renderCpu(cells!, context, image, pixels);
  }

  const materialButtons: readonly [string, PixelMaterial][] = [
    ["pixel-sand", MATERIAL.sand],
    ["pixel-water", MATERIAL.water],
    ["pixel-wall", MATERIAL.wall],
    ["pixel-erase", MATERIAL.empty],
  ];
  for (const [id, material] of materialButtons) {
    required(host, id).addEventListener("click", () => {
      selectedMaterial.value = material;
      workerClient?.setMaterial(material);
      for (const [candidateId, candidate] of materialButtons) {
        required(host, candidateId).classList.toggle("life-primary", candidate === material);
      }
    });
  }
  required(host, "pixel-toggle").addEventListener("click", () => {
    running.value = workerClient?.toggleRunning() ?? !running.value;
  });

  let pendingBrush: PendingBrush | null = null;
  const queueBrush = (event: PointerEvent): void => {
    const rect = canvas.getBoundingClientRect();
    pendingBrush = {
      x: clamp(
        Math.floor((event.clientX - rect.left) * width / Math.max(1, rect.width)),
        0,
        width - 1,
      ),
      y: clamp(
        Math.floor((event.clientY - rect.top) * height / Math.max(1, rect.height)),
        0,
        height - 1,
      ),
      material: selectedMaterial.value,
      at: performance.now(),
    };
  };
  canvas.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    if (event.isTrusted) canvas.setPointerCapture(event.pointerId);
    if (workerClient === null) queueBrush(event);
    else workerClient.pointerDown(event);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (event.buttons === 0) return;
    if (workerClient === null) queueBrush(event);
    else workerClient.pointerMove(event);
  });
  canvas.addEventListener("pointerup", (event) => workerClient?.pointerUp(event));
  canvas.addEventListener("pointercancel", (event) => workerClient?.pointerCancel(event));
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());

  let phase = 0;
  let animationFrame = 0;
  let previousFrameAt = 0;
  let frameWindowStarted = performance.now();
  let framesInWindow = 0;
  const tickSamples: number[] = [];
  const computeSamples: number[] = [];
  const renderSamples: number[] = [];
  const inputSamples: number[] = [];
  const gapSamples: number[] = [];
  const mainFrameSamples: number[] = [];
  const brushRadius = Math.max(2, Math.floor(width / 128));
  let renderedWorkerTick = -1;
  let renderedWorkerInputSequence = 0;
  let stopped = false;
  const frame = async (frameAt: number): Promise<void> => {
    if (stopped) return;
    const mainFrameStarted = performance.now();
    if (previousFrameAt > 0) appendSample(gapSamples, frameAt - previousFrameAt);
    previousFrameAt = frameAt;
    burnMainThread(mainLoadMs);
    let presented = false;
    if (workerClient !== null) {
      if (workerClient.readStats()) {
        const stats = workerClient.stats;
        running.value = stats[4] !== 0;
        const nextTick = stats[0]! >>> 0;
        const nextInputSequence = stats[6]! >>> 0;
        const tickChanged = nextTick !== renderedWorkerTick;
        const inputChanged = nextInputSequence !== renderedWorkerInputSequence;
        if (tickChanged || inputChanged) {
          if (tickChanged) {
            const computeMs = (stats[1]! >>> 0) / 1_000;
            const renderMs = (stats[2]! >>> 0) / 1_000;
            if (computeMs > 0) appendSample(computeSamples, computeMs);
            if (renderMs > 0) appendSample(renderSamples, renderMs);
            if (computeMs > 0 || renderMs > 0) appendSample(tickSamples, computeMs + renderMs);
            renderedWorkerTick = nextTick;
            tickCount.value = nextTick;
          }
          if (inputChanged) {
            renderedWorkerInputSequence = nextInputSequence;
            const nowMicros = Math.round(performance.now() * 1_000) >>> 0;
            appendSample(inputSamples, ((nowMicros - (stats[5]! >>> 0)) >>> 0) / 1_000);
            inputLatency.value = median(inputSamples);
          }
          activeChunkCount.value = stats[3]! >>> 0;
          presented = true;
        }
      }
    } else {
      const brush = pendingBrush;
      pendingBrush = null;
      if (brush !== null) {
        if (gpu !== null) {
          await gpu.paintAndRender(brush.x, brush.y, brushRadius, brush.material);
        } else {
          paintPixelCircle(cells!, width, height, brush.x, brush.y, brushRadius, brush.material);
          active?.activateRect(
            brush.x - brushRadius,
            brush.y - brushRadius,
            brush.x + brushRadius,
            brush.y + brushRadius,
          );
          const renderStarted = performance.now();
          renderCpu(cells!, context!, image!, pixels!);
          appendSample(renderSamples, performance.now() - renderStarted);
        }
        appendSample(inputSamples, performance.now() - brush.at);
        inputLatency.value = median(inputSamples);
        presented = true;
      } else if (running.value) {
        if (gpu !== null) {
          appendSample(tickSamples, await gpu.stepAndRender(phase));
        } else {
          const started = performance.now();
          const computeStarted = performance.now();
          if (active === null) {
            stepPixelWorld(cells!, width, height, phase);
          } else {
            activeChunkCount.value = active.step(phase);
          }
          appendSample(computeSamples, performance.now() - computeStarted);
          const renderStarted = performance.now();
          renderCpu(cells!, context!, image!, pixels!);
          appendSample(renderSamples, performance.now() - renderStarted);
          appendSample(tickSamples, performance.now() - started);
        }
        phase++;
        tickCount.value = phase;
        presented = true;
      }
    }
    if (presented) framesInWindow++;
    if (tickSamples.length > 0) tickMedian.value = median(tickSamples);
    if (computeSamples.length > 0) computeMedian.value = median(computeSamples);
    if (renderSamples.length > 0) renderMedian.value = median(renderSamples);
    appendSample(mainFrameSamples, performance.now() - mainFrameStarted);
    mainFrameMedian.value = median(mainFrameSamples);
    const now = performance.now();
    if (now - frameWindowStarted >= 500) {
      fps.value = framesInWindow * 1_000 / (now - frameWindowStarted);
      if (gapSamples.length > 0) frameGapP95.value = summarizeSamples(gapSamples).p95;
      framesInWindow = 0;
      frameWindowStarted = now;
    }
    animationFrame = requestAnimationFrame((next) => void frame(next));
  };
  animationFrame = requestAnimationFrame((next) => void frame(next));
  addEventListener("pagehide", () => {
    stopped = true;
    cancelAnimationFrame(animationFrame);
    if (gpu !== null) void gpu[Symbol.asyncDispose]();
    workerClient?.dispose();
  }, { once: true });

  if (!autorun) return null;
  await waitFor(() => tickCount.value >= 20, 5_000);
  const rect = canvas.getBoundingClientRect();
  for (let sample = 0; sample < 11; sample++) {
    const previousSamples = inputSamples.length;
    canvas.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        pointerId: 73,
        buttons: 1,
        button: 0,
        clientX: rect.left + rect.width * (0.15 + sample * 0.065),
        clientY: rect.top + rect.height * (0.2 + sample * 0.035),
      }),
    );
    await waitFor(() => inputSamples.length > previousSamples, 1_000);
  }
  await waitFor(() => tickCount.value >= 90, 10_000);
  const summary = summarizeSamples(tickSamples);
  return {
    runtime,
    cells: width * height,
    occupancy,
    region,
    ticks: tickCount.value,
    tickMedianMs: summary.median,
    tickP95Ms: summary.p95,
    computeMedianMs: computeSamples.length === 0 ? 0 : median(computeSamples),
    renderMedianMs: renderSamples.length === 0 ? 0 : median(renderSamples),
    inputLatencyMs: inputLatency.value,
    frameGapP95Ms: frameGapP95.value,
    mainFrameMedianMs: mainFrameMedian.value,
    paintFps: fps.value,
    residentBytes: gpu?.residentBytes ?? workerClient?.residentBytes ??
      cells!.byteLength + (image?.data.byteLength ?? 0) + (active?.residentBytes ?? 0),
    adapter: backend.value,
    mainLoadMs,
    activeChunks: active?.activeChunkCount ?? workerClient?.stats[3] ?? 0,
    chunkCount: active?.chunkCount ?? workerClient?.chunkCount ?? 0,
  };
}

function renderCpu(
  cells: Uint32Array,
  context: CanvasRenderingContext2D,
  image: ImageData,
  pixels: Uint32Array,
): void {
  for (let index = 0; index < cells.length; index++) {
    pixels[index] = MATERIAL_COLORS[pixelMaterial(cells[index]!) as 0 | 1 | 2 | 3];
  }
  context.putImageData(image, 0, 0);
}

function pixelHref(
  runtime: PixelRuntime,
  width: number,
  occupancy: number,
  region: PixelRegion,
): string {
  return `?run=pixel&runtime=${runtime}&size=${width}&occupancy=${occupancy}&region=${region}`;
}

function materialName(material: PixelMaterial): string {
  if (material === MATERIAL.wall) return "wall";
  if (material === MATERIAL.sand) return "sand";
  if (material === MATERIAL.water) return "water";
  return "eraser";
}

function adapterLabel(info: GPUAdapterInfo): string {
  return info.description || info.device || info.vendor || "WebGPU device";
}

function appendSample(samples: number[], value: number): void {
  samples.push(value);
  if (samples.length > 180) samples.shift();
}

function median(values: readonly number[]): number {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function burnMainThread(milliseconds: number): void {
  if (milliseconds <= 0) return;
  const deadline = performance.now() + milliseconds;
  while (performance.now() < deadline) {
    // Model unrelated main-thread application work.
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
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

async function waitFor(predicate: () => boolean, timeout: number): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("pixel demo timed out");
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
}
