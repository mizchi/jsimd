import { advancePixelGear, type PixelGearState } from "../gear.ts";
import { createPixelGelBlob, type PixelGelCluster, stepPixelGel } from "../gel.ts";
import {
  createPixelScenario,
  MATERIAL,
  paintPixelCircle,
  type PixelMaterial,
  pixelMaterial,
  stepPixelWorld,
} from "../../ui-core-simd/pixel_sim.ts";
import { SimdUi, type UiContainer, type UiDocument } from "../../ui-core-simd/signals.ts";

const WIDTH = 512;
const HEIGHT = 320;
const COLORS = [0xff15100c, 0xff615950, 0xff3db0f0, 0xffe88c2e] as const;

export function mountPixelGearDemo(host: HTMLElement): void {
  document.title = "Pixel × Gear — jsimd";
  document.body.classList.add("life-mode", "pixel-mode", "gear-mode");
  const ui = new SimdUi({ document: document as unknown as UiDocument });
  const running = ui.signal(true);
  const ticks = ui.signal(0);
  const pushed = ui.signal(0);
  const gelClusters = ui.signal(1);
  const fractures = ui.signal(0);
  const boundaryChecks = ui.signal(0);
  const direction = ui.signal("clockwise");
  const selectedMaterial = ui.signal<PixelMaterial>(MATERIAL.sand);
  const root = ui.element("div", { className: "life-shell pixel-shell" }, [
    ui.element("header", { className: "life-hero" }, [
      ui.element("div", {}, [
        ui.element("p", { className: "eyebrow" }, ["jsimd × bonded aggregate experiment"]),
        ui.element("h1", {}, ["Pixel × Gear × Gel"]),
        ui.element("p", { className: "life-lead" }, [
          "A high-viscosity bonded aggregate moves as one body, then fractures locally when the rotating gear exceeds its bond strength.",
        ]),
      ]),
      ui.element("div", { className: "life-badge pixel-badge gear-badge" }, [
        ui.element("span", {}, ["INTERACTION"]),
        ui.element("strong", {}, ["GEAR"]),
        ui.element("small", {}, ["boundary-only collision"]),
      ]),
    ]),
    ui.element("section", { className: "life-stage" }, [
      ui.element("div", { className: "life-canvas-frame pixel-canvas-frame" }, [
        ui.element("canvas", {
          id: "gear-canvas",
          width: WIDTH,
          height: HEIGHT,
          ariaLabel: "Interactive sand, water, and rotating gear simulation",
          tabIndex: 0,
        }),
        ui.element("div", { className: "life-overlay gear-overlay" }, [
          ui.element("span", { className: "life-status-dot" }),
          ui.text([running], () => running.value ? "GEAR ENGAGED" : "PAUSED"),
        ]),
      ]),
      ui.element("aside", { className: "life-console" }, [
        ui.element("div", { className: "gear-kicker" }, ["LIVE COLLISION"]),
        ui.element("div", { className: "life-stats gear-stats" }, [
          stat(ui, "ticks", ui.text([ticks], () => ticks.value.toLocaleString())),
          stat(ui, "cells pushed", ui.text([pushed], () => pushed.value.toLocaleString())),
          stat(
            ui,
            "gel clusters",
            ui.text([gelClusters], () => gelClusters.value.toLocaleString()),
          ),
          stat(ui, "fractures", ui.text([fractures], () => fractures.value.toLocaleString())),
          stat(
            ui,
            "boundary checks",
            ui.text([boundaryChecks], () => boundaryChecks.value.toLocaleString()),
          ),
          stat(ui, "rotation", ui.text([direction], () => direction.value)),
        ]),
        ui.element("div", { className: "life-controls pixel-materials gear-materials" }, [
          ui.element("button", { id: "gear-sand", className: "life-primary" }, ["Sand"]),
          ui.element("button", { id: "gear-water" }, ["Water"]),
          ui.element("button", { id: "gear-erase" }, ["Erase"]),
        ]),
        ui.element("div", { className: "life-controls" }, [
          ui.element("button", { id: "gear-drop-gel", className: "gear-gel-button" }, [
            "Drop gel",
          ]),
          ui.element("button", { id: "gear-reverse", className: "gear-reverse" }, ["Reverse"]),
          ui.element("button", { id: "gear-toggle", className: "life-primary" }, [
            ui.text([running], () => running.value ? "Pause" : "Play"),
          ]),
          ui.element("button", { id: "gear-reset" }, ["Reset all"]),
        ]),
        ui.element("p", { className: "life-hint" }, [
          ui.text(
            [selectedMaterial],
            () =>
              `Brush: ${
                materialName(selectedMaterial.value)
              }. The mint gel is simulated as a bonded cluster; Drop gel adds another aggregate.`,
          ),
        ]),
      ]),
    ]),
    ui.element("footer", { className: "life-footer" }, [
      ui.element("span", {}, ["separate rigid-body state"]),
      ui.element("span", {}, ["steady state O(boundary)"]),
      ui.element("span", {}, ["O(cells) only on fracture"]),
    ]),
  ]);
  host.replaceChildren();
  void ui.mount(host as unknown as UiContainer, root).then(() =>
    runDemo(
      host,
      running,
      ticks,
      pushed,
      gelClusters,
      fractures,
      boundaryChecks,
      direction,
      selectedMaterial,
    )
  );
}

function runDemo(
  host: HTMLElement,
  running: { value: boolean },
  ticks: { value: number },
  pushed: { value: number },
  gelClusterCount: { value: number },
  fractureCount: { value: number },
  boundaryCheckCount: { value: number },
  direction: { value: string },
  selectedMaterial: { value: PixelMaterial },
): void {
  const canvas = required<HTMLCanvasElement>(host, "gear-canvas");
  const context = canvas.getContext("2d", { alpha: false });
  if (context === null) throw new Error("2D canvas is unavailable");
  const image = context.createImageData(WIDTH, HEIGHT);
  const pixels = new Uint32Array(image.data.buffer);
  let cells = createScenario();
  let gear = initialGear();
  let gel = createGelScenario();
  const gelSprites = new Map<number, GelSprite>();
  let pendingBrush: { readonly x: number; readonly y: number } | null = null;

  const materialButtons: readonly [string, PixelMaterial][] = [
    ["gear-sand", MATERIAL.sand],
    ["gear-water", MATERIAL.water],
    ["gear-erase", MATERIAL.empty],
  ];
  for (const [id, material] of materialButtons) {
    required(host, id).addEventListener("click", () => {
      selectedMaterial.value = material;
      for (const [candidateId, candidate] of materialButtons) {
        required(host, candidateId).classList.toggle("life-primary", candidate === material);
      }
    });
  }
  required(host, "gear-toggle").addEventListener("click", () => running.value = !running.value);
  required(host, "gear-drop-gel").addEventListener("click", () => {
    gel.push(createGel(WIDTH * (0.42 + Math.random() * 0.2), HEIGHT * 0.12));
    gelClusterCount.value = gel.length;
  });
  required(host, "gear-reverse").addEventListener("click", () => {
    gear = { ...gear, angularVelocity: -gear.angularVelocity };
    direction.value = gear.angularVelocity > 0 ? "clockwise" : "counterclockwise";
  });
  required(host, "gear-reset").addEventListener("click", () => {
    cells = createScenario();
    gear = initialGear();
    gel = createGelScenario();
    gelSprites.clear();
    ticks.value = 0;
    pushed.value = 0;
    gelClusterCount.value = gel.length;
    fractureCount.value = 0;
    boundaryCheckCount.value = 0;
    direction.value = "clockwise";
  });

  const queueBrush = (event: PointerEvent): void => {
    const rect = canvas.getBoundingClientRect();
    pendingBrush = {
      x: clamp(
        Math.floor((event.clientX - rect.left) * WIDTH / Math.max(1, rect.width)),
        0,
        WIDTH - 1,
      ),
      y: clamp(
        Math.floor((event.clientY - rect.top) * HEIGHT / Math.max(1, rect.height)),
        0,
        HEIGHT - 1,
      ),
    };
  };
  canvas.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    if (event.isTrusted) canvas.setPointerCapture(event.pointerId);
    queueBrush(event);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (event.buttons !== 0) queueBrush(event);
  });
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());

  let phase = 0;
  let stopped = false;
  const frame = (): void => {
    if (stopped) return;
    if (pendingBrush !== null) {
      paintPixelCircle(
        cells,
        WIDTH,
        HEIGHT,
        pendingBrush.x,
        pendingBrush.y,
        5,
        selectedMaterial.value,
      );
      pendingBrush = null;
    }
    if (running.value) {
      stepPixelWorld(cells, WIDTH, HEIGHT, phase);
      const result = advancePixelGear(cells, WIDTH, HEIGHT, gear);
      gear = result.gear;
      pushed.value += result.moves;
      const gelResult = stepPixelGel(gel, WIDTH, HEIGHT, gear, {
        minimumFragmentCells: 320,
      });
      gel = gelResult.clusters;
      gelClusterCount.value = gel.length;
      fractureCount.value += gelResult.fractures;
      boundaryCheckCount.value = gelResult.boundaryChecks;
      phase++;
      ticks.value = phase;
    }
    render(context, image, pixels, cells, gear, gel, gelSprites);
    requestAnimationFrame(frame);
  };
  render(context, image, pixels, cells, gear, gel, gelSprites);
  requestAnimationFrame(frame);
  addEventListener("pagehide", () => stopped = true, { once: true });
}

function createScenario(): Uint32Array {
  const cells = createPixelScenario(WIDTH, HEIGHT, 0.24, 0x6e61_7267, "quarter");
  const gear = initialGear();
  paintPixelCircle(
    cells,
    WIDTH,
    HEIGHT,
    gear.centerX,
    gear.centerY,
    gear.radius + gear.toothDepth + 3,
    MATERIAL.empty,
  );
  return cells;
}

function initialGear(): PixelGearState {
  return {
    centerX: WIDTH * 0.52,
    centerY: HEIGHT * 0.67,
    radius: 44,
    toothDepth: 13,
    teeth: 14,
    angle: 0,
    angularVelocity: 0.032,
  };
}

function createGelScenario(): PixelGelCluster[] {
  return [createGel(WIDTH * 0.5, HEIGHT * 0.13)];
}

function createGel(centerX: number, centerY: number): PixelGelCluster {
  const gel = createPixelGelBlob(centerX, centerY, 42, 24, { strength: 34 });
  gel.velocityX = 0.12;
  return gel;
}

function render(
  context: CanvasRenderingContext2D,
  image: ImageData,
  pixels: Uint32Array,
  cells: Uint32Array,
  gear: PixelGearState,
  gel: readonly PixelGelCluster[],
  gelSprites: Map<number, GelSprite>,
): void {
  for (let index = 0; index < cells.length; index++) {
    pixels[index] = COLORS[pixelMaterial(cells[index]!) as 0 | 1 | 2 | 3];
  }
  context.putImageData(image, 0, 0);
  drawGel(context, gel, gelSprites);
  drawGear(context, gear);
}

interface GelSprite {
  readonly canvas: HTMLCanvasElement;
  readonly originX: number;
  readonly originY: number;
}

function drawGel(
  context: CanvasRenderingContext2D,
  clusters: readonly PixelGelCluster[],
  sprites: Map<number, GelSprite>,
): void {
  context.imageSmoothingEnabled = false;
  for (const cluster of clusters) {
    let sprite = sprites.get(cluster.id);
    if (sprite === undefined) {
      sprite = createGelSprite(cluster);
      sprites.set(cluster.id, sprite);
    }
    context.save();
    context.translate(cluster.centerX, cluster.centerY);
    context.rotate(cluster.angle);
    context.shadowColor = "rgb(93 255 201 / 45%)";
    context.shadowBlur = 7;
    context.drawImage(sprite.canvas, sprite.originX, sprite.originY);
    context.restore();
  }
}

function createGelSprite(cluster: PixelGelCluster): GelSprite {
  let minimumX = Infinity;
  let minimumY = Infinity;
  let maximumX = -Infinity;
  let maximumY = -Infinity;
  for (let index = 0; index < cluster.cells.length; index += 2) {
    minimumX = Math.min(minimumX, cluster.cells[index]!);
    minimumY = Math.min(minimumY, cluster.cells[index + 1]!);
    maximumX = Math.max(maximumX, cluster.cells[index]!);
    maximumY = Math.max(maximumY, cluster.cells[index + 1]!);
  }
  const originX = minimumX - 0.5;
  const originY = minimumY - 0.5;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(maximumX - minimumX + 1);
  canvas.height = Math.ceil(maximumY - minimumY + 1);
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("gel sprite canvas is unavailable");
  context.fillStyle = cluster.id % 3 === 0
    ? "#51dcb3"
    : cluster.id % 3 === 1
    ? "#78f0c8"
    : "#64e5bf";
  for (let index = 0; index < cluster.cells.length; index += 2) {
    context.fillRect(
      Math.round(cluster.cells[index]! - 0.5 - originX),
      Math.round(cluster.cells[index + 1]! - 0.5 - originY),
      1,
      1,
    );
  }
  return { canvas, originX, originY };
}

function drawGear(context: CanvasRenderingContext2D, gear: PixelGearState): void {
  const pointsPerTooth = 4;
  context.save();
  context.translate(gear.centerX, gear.centerY);
  context.rotate(gear.angle);
  context.beginPath();
  for (let point = 0; point < gear.teeth * pointsPerTooth; point++) {
    const toothPhase = point % pointsPerTooth;
    const radius = toothPhase === 1 || toothPhase === 2
      ? gear.radius + gear.toothDepth
      : gear.radius;
    const angle = point / (gear.teeth * pointsPerTooth) * Math.PI * 2;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (point === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.closePath();
  const gradient = context.createRadialGradient(-12, -15, 5, 0, 0, gear.radius + gear.toothDepth);
  gradient.addColorStop(0, "#ffe19a");
  gradient.addColorStop(0.52, "#d6942d");
  gradient.addColorStop(1, "#754214");
  context.fillStyle = gradient;
  context.fill();
  context.lineWidth = 2;
  context.strokeStyle = "#ffe6a8";
  context.stroke();
  context.beginPath();
  context.arc(0, 0, gear.radius * 0.29, 0, Math.PI * 2);
  context.fillStyle = "#15100c";
  context.fill();
  context.lineWidth = 3;
  context.strokeStyle = "#efb84e";
  context.stroke();
  context.restore();
}

function materialName(material: PixelMaterial): string {
  if (material === MATERIAL.sand) return "sand";
  if (material === MATERIAL.water) return "water";
  return "eraser";
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

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
