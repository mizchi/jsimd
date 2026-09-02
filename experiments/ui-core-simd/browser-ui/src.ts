import { batch as preactBatch, computed as preactComputed, signal } from "@preact/signals";
import { type ComponentChild, h, options as preactOptions, render } from "preact";
import { type BenchmarkSummary, summarizeSamples } from "../benchmark_stats.ts";
import { computed as simdComputed } from "../computed.ts";
import {
  type ComplexTreeNode,
  complexTreeStats,
  createComplexTreePlan,
  dependencyIds,
} from "../complex_tree.ts";
import {
  layeredDependencyIds,
  type LayeredGraphShape,
  layeredGraphStats,
} from "../layered_graph.ts";
import { applyTextI32Batch, NumericPatchTape, type PatchBinding } from "../patch_tape.ts";
import {
  createPatchScenarioPlan,
  PATCH_SCENARIOS,
  type PatchScenario,
  type PatchScenarioPlan,
  projectPatchScenarioValue,
  updatePatchScenarioValue,
} from "../patch_scenarios.ts";
import {
  SimdUi,
  type UiContainer,
  type UiDocument,
  type UiNode,
  type UiSignal,
} from "../signals.ts";
import { mountRuntimeProfilePage, type ProfileRuntime } from "./profile.ts";
import { runAtomicInputDemo } from "./input_demo.ts";
import { mountLifeDemo } from "./life_demo.ts";
import {
  type LifeRendererPreference,
  type LifeRuntime,
  parseLifeMainLoadMs,
} from "../life_options.ts";
import {
  parsePixelOccupancy,
  parsePixelRegion,
  parsePixelRuntime,
  parsePixelWidth,
} from "../pixel_options.ts";

interface Comparison {
  readonly size: number;
  readonly simdMs: number;
  readonly preactMs: number;
  readonly simdP95Ms: number;
  readonly preactP95Ms: number;
  readonly simdMountMs: number;
  readonly preactMountMs: number;
  readonly simdDetail: string;
}

interface BenchmarkResults {
  readonly fanout: readonly Comparison[];
  readonly patchTape: readonly PatchTapeComparison[];
  readonly derived: readonly Comparison[];
  readonly layered: readonly Comparison[];
  readonly complexTree: readonly Comparison[];
}

interface PatchTapeComparison {
  readonly size: number;
  readonly directMs: number;
  readonly directP95Ms: number;
  readonly patchMs: number;
  readonly patchP95Ms: number;
  readonly preactMs: number;
  readonly preactP95Ms: number;
  readonly patchMountMs: number;
  readonly detail: string;
}

interface PatchScenarioComparison {
  readonly size: number;
  readonly scenario: string;
  readonly label: string;
  readonly affectedBindingCount: number;
  readonly flushCount: number;
  readonly dependenciesPerBinding: number;
  readonly directMs: number;
  readonly directP95Ms: number;
  readonly patchMs: number;
  readonly patchP95Ms: number;
  readonly preactMs: number;
  readonly preactP95Ms: number;
  readonly patchCount: number;
  readonly dispatch: string;
}

const COMPLEX_SIGNAL_COUNT = 32;
const COMPLEX_BINDINGS_PER_LEAF = 4;
const COMPLEX_DEPENDENCIES_PER_BINDING = 4;
const LAYERED_GRAPH_SHAPES: readonly LayeredGraphShape[] = [
  { width: 1_024, depth: 4, inputCount: 32, dependenciesPerNode: 4 },
  { width: 256, depth: 16, inputCount: 32, dependenciesPerNode: 4 },
  { width: 64, depth: 64, inputCount: 32, dependenciesPerNode: 4 },
  { width: 2_048, depth: 8, inputCount: 32, dependenciesPerNode: 4 },
  { width: 256, depth: 64, inputCount: 32, dependenciesPerNode: 4 },
  { width: 64, depth: 256, inputCount: 32, dependenciesPerNode: 4 },
];

const benchmarkGlobal = globalThis as typeof globalThis & {
  __jsimdUiBench: {
    readonly ready: true;
    results: BenchmarkResults | null;
    runAll(): Promise<BenchmarkResults>;
  };
};

const uiDocument = document as unknown as UiDocument;
const asContainer = (element: Element): UiContainer => element as unknown as UiContainer;

await mountDemos();

const runButton = required<HTMLButtonElement>("run-all");
benchmarkGlobal.__jsimdUiBench = { ready: true, results: null, runAll: runAndRender };
const benchmarkParams = new URLSearchParams(location.search);
if (benchmarkParams.get("run") === "pixel-block-webgpu-event-bench") {
  runButton.disabled = true;
  const { runPixelBlockWebGpuEventBenchmark } = await import(
    "./pixel_block_webgpu_event_bench.ts"
  );
  report({ pixelBlockWebGpuEventBenchmark: await runPixelBlockWebGpuEventBenchmark() });
} else if (benchmarkParams.get("run") === "pixel-block-webgpu-check") {
  runButton.disabled = true;
  const {
    checkPixelBlockWebGpu,
    checkPixelBlockWebGpuEvents,
    checkPixelReactionWebGpuEvents,
  } = await import(
    "./pixel_block_webgpu_check.ts"
  );
  report({
    pixelBlockWebGpuCheck: await checkPixelBlockWebGpu(),
    pixelBlockWebGpuEventCheck: await checkPixelBlockWebGpuEvents(),
    pixelReactionWebGpuEventCheck: await checkPixelReactionWebGpuEvents(),
  });
} else if (benchmarkParams.get("run") === "pixel") {
  runButton.disabled = true;
  const width = parsePixelWidth(benchmarkParams.get("size"));
  const { mountPixelDemo } = await import("./pixel_demo.ts");
  const result = await mountPixelDemo(
    document.querySelector("main")!,
    benchmarkParams.get("autorun") === "1",
    parsePixelRuntime(benchmarkParams.get("runtime")),
    width,
    width * 5 / 8,
    parsePixelOccupancy(benchmarkParams.get("occupancy")),
    parsePixelRegion(benchmarkParams.get("region")),
    parseLifeMainLoadMs(benchmarkParams.get("load")),
  );
  if (result !== null) report({ pixel: result });
} else if (benchmarkParams.get("run") === "life") {
  runButton.disabled = true;
  const width = parseLifeWidth(benchmarkParams.get("size"));
  const result = await mountLifeDemo(
    document.querySelector("main")!,
    benchmarkParams.get("autorun") === "1",
    parseLifeRuntime(benchmarkParams.get("runtime")),
    width,
    width * 5 / 8,
    parseLifeRenderer(benchmarkParams.get("renderer")),
    parseLifeMainLoadMs(benchmarkParams.get("load")),
  );
  if (result !== null) report({ life: result });
} else if (benchmarkParams.get("run") === "input") {
  runButton.disabled = true;
  const result = await runAtomicInputDemo(
    required("simd-demo"),
    required("status"),
    benchmarkParams.get("autorun") === "1",
  );
  if (result !== null) report({ atomicInput: result });
} else if (benchmarkParams.get("run") === "profile") {
  const runtime = parseProfileRuntime(benchmarkParams.get("runtime"));
  const requestedSize = Number(benchmarkParams.get("size"));
  const size = Number.isFinite(requestedSize) && requestedSize > 0 ? requestedSize : 4_096;
  await mountRuntimeProfilePage({
    size,
    runtime,
    document: uiDocument,
    host: required("profile-host"),
    button: runButton,
    status: required("status"),
    autorun: benchmarkParams.get("autorun") === "1",
    report: (result) => report({ runtimeProfile: result }),
  });
} else if (benchmarkParams.get("run") === "layered") {
  runButton.addEventListener("click", () => void runAndRender());
  void runLayeredCase(Number(benchmarkParams.get("case") ?? 0));
} else if (benchmarkParams.get("run") === "patch") {
  runButton.addEventListener("click", () => void runAndRender());
  void runPatchCases();
} else if (benchmarkParams.get("run") === "patch-matrix") {
  runButton.addEventListener("click", () => void runAndRender());
  const requestedSize = Number(benchmarkParams.get("size"));
  void runPatchMatrix(Number.isFinite(requestedSize) && requestedSize > 0 ? requestedSize : null);
} else {
  runButton.addEventListener("click", () => void runAndRender());
  if (benchmarkParams.has("run")) void runAndRender();
}

function parseLifeRuntime(value: string | null): LifeRuntime {
  if (value === null || value === "simd") return "simd";
  if (value === "scalar") return "scalar";
  throw new TypeError(`unknown Life runtime: ${value}`);
}

function parseLifeRenderer(value: string | null): LifeRendererPreference {
  if (value === null || value === "auto") return "auto";
  if (value === "main" || value === "offscreen") return value;
  throw new TypeError(`unknown Life renderer: ${value}`);
}

function parseLifeWidth(value: string | null): number {
  const width = value === null ? 256 : Number(value);
  if (width === 256 || width === 512 || width === 1_024) return width;
  throw new RangeError(`unsupported Life width: ${value}`);
}

function parseProfileRuntime(value: string | null): ProfileRuntime {
  if (value === "direct" || value === "patch" || value === "preact" || value === "atomics") {
    return value;
  }
  throw new TypeError(`unknown profile runtime: ${value}`);
}

async function mountDemos(): Promise<void> {
  const simdHost = required("simd-demo");
  const ui = new SimdUi({ document: uiDocument });
  const count = ui.signal(0);
  const simdRoot = ui.element("div", { className: "counter" }, [
    ui.element("button", { onclick: () => count.value++ }, ["Increment"]),
    "Count: ",
    ui.text([count], () => String(count.value)),
  ]);
  await ui.mount(asContainer(simdHost), simdRoot);

  const preactHost = required("preact-demo");
  const preactCount = signal(0);
  render(
    h("div", { class: "counter" }, [
      h("button", { onClick: () => preactCount.value++ }, "Increment"),
      "Count: ",
      preactCount as unknown as ComponentChild,
    ]),
    preactHost,
  );
}

async function runAndRender(): Promise<BenchmarkResults> {
  runButton.disabled = true;
  const status = required("status");
  status.textContent = "Running fine-grained binding benchmarks…";
  await nextFrame();
  const fanout: Comparison[] = [];
  for (const size of [64, 512, 4096]) {
    fanout.push(await compareFanout(size));
    status.textContent = `Fine-grained: ${size.toLocaleString()} bindings complete`;
    await nextFrame();
  }

  status.textContent = "Running patch-tape benchmarks…";
  const patchTape: PatchTapeComparison[] = [];
  for (const baseline of fanout) {
    patchTape.push(await comparePatchTape(baseline));
    status.textContent = `Patch tape: ${baseline.size.toLocaleString()} bindings complete`;
    await nextFrame();
  }

  status.textContent = "Running derived graph benchmarks…";
  const derived: Comparison[] = [];
  for (const size of [16, 64, 256]) {
    derived.push(await compareDerived(size));
    status.textContent = `Derived graph: ${size.toLocaleString()} outputs complete`;
    await nextFrame();
  }

  status.textContent = "Running layered graph benchmarks…";
  const layered: Comparison[] = [];
  for (const shape of LAYERED_GRAPH_SHAPES) {
    layered.push(await compareLayered(shape));
    status.textContent =
      `Layered graph: ${shape.width.toLocaleString()} wide × ${shape.depth.toLocaleString()} deep complete`;
    await nextFrame();
  }

  status.textContent = "Running complex tree benchmarks…";
  const complexTree: Comparison[] = [];
  for (const size of [64, 256, 1_024]) {
    complexTree.push(await compareComplexTree(size));
    status.textContent = `Complex tree: ${size.toLocaleString()} leaves complete`;
    await nextFrame();
  }

  const results = { fanout, patchTape, derived, layered, complexTree };
  benchmarkGlobal.__jsimdUiBench.results = results;
  renderTable(required("fanout-results"), fanout);
  renderPatchTapeTable(required("patch-tape-results"), patchTape);
  renderTable(required("derived-results"), derived);
  renderTable(required("layered-results"), layered);
  renderTable(required("complex-tree-results"), complexTree);
  status.textContent = "Complete";
  runButton.disabled = false;
  report(results);
  return results;
}

async function runPatchCases(): Promise<void> {
  runButton.disabled = true;
  const status = required("status");
  const fanout: Comparison[] = [];
  const patchTape: PatchTapeComparison[] = [];
  for (const size of [64, 512, 4096]) {
    status.textContent = `Patch comparison: ${size.toLocaleString()} bindings…`;
    await nextFrame();
    const baseline = await compareFanout(size);
    fanout.push(baseline);
    patchTape.push(await comparePatchTape(baseline));
  }
  renderTable(required("fanout-results"), fanout);
  renderPatchTapeTable(required("patch-tape-results"), patchTape);
  status.textContent = "Complete";
  runButton.disabled = false;
  report({ fanout, patchTape });
}

async function runPatchMatrix(requestedSize: number | null): Promise<void> {
  const sizes = requestedSize === null ? [64, 512, 4_096, 16_384] : [requestedSize];
  runButton.disabled = true;
  const status = required("status");
  const results: PatchScenarioComparison[] = [];
  for (const size of sizes) {
    for (const scenario of PATCH_SCENARIOS) {
      status.textContent = `${scenario.label}: ${size.toLocaleString()} bindings…`;
      await nextFrame();
      results.push(await comparePatchScenario(size, scenario));
      renderPatchScenarioTable(required("patch-scenario-results"), results);
    }
  }
  status.textContent = "Complete";
  runButton.disabled = false;
  report({ patchScenarios: results });
}

async function comparePatchScenario(
  size: number,
  scenario: PatchScenario,
): Promise<PatchScenarioComparison> {
  const plan = createPatchScenarioPlan(size, scenario);
  const repetitions = patchScenarioRepetitions(size, scenario);

  const directSandbox = sandbox();
  const directUi = new SimdUi({ document: uiDocument });
  const directInputs = Array.from({ length: plan.signalCount }, () => directUi.signal(0));
  const directChildren: UiNode[] = [];
  for (let bindingId = 0; bindingId < size; bindingId++) {
    const dependencies = patchScenarioDependencies(directInputs, plan, bindingId);
    if (scenario.projection === "stable-even") {
      const output = simdComputed(
        directUi,
        dependencies,
        () => evaluatePatchScenario(dependencies, scenario),
      );
      directChildren.push(
        directUi.element("span", {}, [directUi.text([output], () => String(output.value))]),
      );
    } else {
      directChildren.push(directUi.element("span", {}, [
        directUi.text(dependencies, () => String(evaluatePatchScenario(dependencies, scenario))),
      ]));
    }
  }
  const directRoot = directUi.element("div", {}, directChildren);
  await directUi.mount(asContainer(directSandbox), directRoot);
  const directProbeNode = scenarioProbe(directSandbox, plan);
  let directTick = 0;
  const direct = measureSamples(() => {
    directTick++;
    updateSimdScenario(directUi, directInputs, plan, scenario, directTick);
    void directProbeNode.textContent;
  }, repetitions);
  const directDispatch = directUi.stats.lastDispatchStrategy ?? "none";
  const directProbe = directProbeNode.textContent;
  directUi.destroy();
  directSandbox.remove();

  const patchSandbox = sandbox();
  const patchUi = new SimdUi({ document: uiDocument });
  const patchInputs = Array.from({ length: plan.signalCount }, () => patchUi.signal(0));
  const bindings: PatchBinding[] = Array.from(
    { length: size },
    (_, target) => ({ kind: "text-i32", target }),
  );
  const tape = await NumericPatchTape.create(bindings);
  const patchTargets: Array<{ data: string }> = [];
  const patchChildren: UiNode[] = [];
  for (let bindingId = 0; bindingId < size; bindingId++) {
    const dependencies = patchScenarioDependencies(patchInputs, plan, bindingId);
    const text = uiDocument.createTextNode("");
    patchTargets.push(text);
    patchUi.effect(
      dependencies,
      () => tape.i32Values[bindingId] = evaluatePatchScenario(dependencies, scenario),
    );
    patchChildren.push(patchUi.element("span", {}, [text]));
  }
  let patchCount = 0;
  patchUi.effect(patchInputs, () => {
    patchCount += applyTextI32Batch(tape.drain(), patchTargets);
  });
  const patchRoot = patchUi.element("div", {}, patchChildren);
  await patchUi.mount(asContainer(patchSandbox), patchRoot);
  const patchProbeNode = scenarioProbe(patchSandbox, plan);
  let patchTick = 0;
  const patch = measureSamples(() => {
    patchTick++;
    patchCount = 0;
    updateSimdScenario(patchUi, patchInputs, plan, scenario, patchTick);
    if (patchCount !== plan.expectedPatchCount) {
      throw new Error(`expected ${plan.expectedPatchCount} patches, got ${patchCount}`);
    }
    void patchProbeNode.textContent;
  }, repetitions);
  const patchDispatch = patchUi.stats.lastDispatchStrategy ?? "none";
  const patchProbe = patchProbeNode.textContent;
  patchUi.destroy();
  patchSandbox.remove();

  const preactSandbox = sandbox();
  const preactInputs = Array.from({ length: plan.signalCount }, () => signal(0));
  const preactOutputs = Array.from({ length: size }, (_, bindingId) => {
    const dependencies = patchScenarioDependencies(preactInputs, plan, bindingId);
    return preactComputed(() => evaluatePatchScenario(dependencies, scenario));
  });
  render(
    h(
      "div",
      {},
      preactOutputs.map((output) => h("span", {}, output as unknown as ComponentChild)),
    ),
    preactSandbox,
  );
  const preactProbeNode = scenarioProbe(preactSandbox, plan);
  let preactTick = 0;
  const preact = measurePreactSamples(() => {
    preactTick++;
    updatePreactScenario(preactInputs, plan, scenario, preactTick);
    void preactProbeNode.textContent;
  }, repetitions);
  const preactProbe = preactProbeNode.textContent;
  const probeBindingId = plan.changedSignalIds[plan.changedSignalIds.length - 1]!;
  const preactInputValue = preactInputs[probeBindingId]!.value;
  const preactOutputValue = preactOutputs[probeBindingId]!.value;
  render(null, preactSandbox);
  preactSandbox.remove();

  if (directProbe !== patchProbe || directProbe !== preactProbe) {
    throw new Error(
      `patch scenario output mismatch: direct=${directProbe}, patch=${patchProbe}, ` +
        `preact=${preactProbe}, input=${preactInputValue}, output=${preactOutputValue}`,
    );
  }

  return {
    size,
    scenario: scenario.id,
    label: scenario.label,
    affectedBindingCount: plan.affectedBindingCount,
    flushCount: plan.flushCount,
    dependenciesPerBinding: plan.dependenciesPerBinding,
    directMs: direct.median,
    directP95Ms: direct.p95,
    patchMs: patch.median,
    patchP95Ms: patch.p95,
    preactMs: preact.median,
    preactP95Ms: preact.p95,
    patchCount,
    dispatch: `${directDispatch}/${patchDispatch}`,
  };
}

async function comparePatchTape(baseline: Comparison): Promise<PatchTapeComparison> {
  const size = baseline.size;
  const signalCount = 16;
  const dependenciesPerBinding = 8;
  const patchSandbox = sandbox();
  const ui = new SimdUi({ document: uiDocument });
  const inputs = Array.from({ length: signalCount }, () => ui.signal(0));
  const bindings: PatchBinding[] = Array.from(
    { length: size },
    (_, target) => ({ kind: "text-i32", target }),
  );
  const tape = await NumericPatchTape.create(bindings);
  const targets: Array<{ data: string }> = [];
  const children: UiNode[] = [];
  for (let bindingId = 0; bindingId < size; bindingId++) {
    const dependencies = dependencySet(inputs, bindingId, dependenciesPerBinding);
    const text = uiDocument.createTextNode("");
    targets.push(text);
    ui.effect(dependencies, () => tape.i32Values[bindingId] = sumNumbers(dependencies));
    children.push(ui.element("span", {}, [text]));
  }
  // Registered last, so one applicator runs after all selected binding evaluators in this round.
  ui.effect(inputs, () => applyTextI32Batch(tape.drain(), targets));
  const root = ui.element("div", {}, children);
  const mountStart = performance.now();
  await ui.mount(asContainer(patchSandbox), root);
  const patchMountMs = performance.now() - mountStart;
  const probe = patchSandbox.querySelector("span:last-child")!;
  let tick = 0;
  const patch = measureSamples(() => {
    tick++;
    ui.batch(() => {
      for (let index = 0; index < signalCount / 2; index++) inputs[index]!.value = tick;
    });
    void probe.textContent;
  }, repetitionsFor(size));
  const dispatch = ui.stats.lastDispatchStrategy ?? "none";
  ui.destroy();
  patchSandbox.remove();

  return {
    size,
    directMs: baseline.simdMs,
    directP95Ms: baseline.simdP95Ms,
    patchMs: patch.median,
    patchP95Ms: patch.p95,
    preactMs: baseline.preactMs,
    preactP95Ms: baseline.preactP95Ms,
    patchMountMs,
    detail: `${dispatch} dispatch / ${tape.lastStrategy ?? "none"} tape`,
  };
}

async function runLayeredCase(index: number): Promise<void> {
  const shape = LAYERED_GRAPH_SHAPES[index];
  if (shape === undefined) throw new RangeError("unknown layered graph case");
  runButton.disabled = true;
  const status = required("status");
  status.textContent =
    `Running ${shape.width.toLocaleString()} wide × ${shape.depth.toLocaleString()} deep…`;
  await nextFrame();
  const layered = [await compareLayered(shape)];
  renderTable(required("layered-results"), layered);
  status.textContent = "Complete";
  runButton.disabled = false;
  report({ layered });
}

function report(results: unknown): void {
  void fetch("/__benchmark_report", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(results),
  }).catch(() => {});
}

async function compareLayered(shape: LayeredGraphShape): Promise<Comparison> {
  const stats = layeredGraphStats(shape);
  const simdSandbox = sandbox();
  const ui = new SimdUi({ document: uiDocument });
  const simdInputs = Array.from({ length: shape.inputCount }, () => ui.signal(0));
  let simdLayer: readonly UiSignal<number>[] = simdInputs;
  for (let depth = 0; depth < shape.depth; depth++) {
    const source = simdLayer;
    simdLayer = Array.from({ length: shape.width }, (_, index) => {
      const dependencies = layeredDependencySet(
        source,
        index + depth * shape.width,
        shape.dependenciesPerNode,
      );
      return simdComputed(ui, dependencies, () => sumNumbers(dependencies) + depth + 1);
    });
  }
  const simdRoot = ui.element(
    "div",
    {},
    simdLayer.map((output) =>
      ui.element("span", {}, [ui.text([output], () => String(output.value))])
    ),
  );
  const simdMountStart = performance.now();
  await ui.mount(asContainer(simdSandbox), simdRoot);
  const simdMountMs = performance.now() - simdMountStart;
  const simdProbe = simdSandbox.querySelector("span:last-child")!;
  let simdTick = 0;
  const simd = measureSamples(() => {
    simdTick++;
    ui.batch(() => {
      for (let index = 0; index < shape.inputCount / 4; index++) {
        simdInputs[index]!.value = simdTick;
      }
    });
    void simdProbe.textContent;
  }, repetitionsFor(stats.computedCount));
  const dispatch = ui.stats.lastDispatchStrategy ?? "none";
  ui.destroy();
  simdSandbox.remove();

  const preactSandbox = sandbox();
  const preactInputs = Array.from({ length: shape.inputCount }, () => signal(0));
  let preactLayer: readonly { readonly value: number }[] = preactInputs;
  for (let depth = 0; depth < shape.depth; depth++) {
    const source = preactLayer;
    preactLayer = Array.from({ length: shape.width }, (_, index) => {
      const dependencies = layeredDependencySet(
        source,
        index + depth * shape.width,
        shape.dependenciesPerNode,
      );
      return preactComputed(() => sumNumbers(dependencies) + depth + 1);
    });
  }
  const preactRoot = h(
    "div",
    {},
    preactLayer.map((output) => h("span", {}, output as unknown as ComponentChild)),
  );
  const preactMountStart = performance.now();
  render(preactRoot, preactSandbox);
  const preactMountMs = performance.now() - preactMountStart;
  const preactProbe = preactSandbox.querySelector("span:last-child")!;
  let preactTick = 0;
  const preact = measurePreactSamples(() => {
    preactTick++;
    preactBatch(() => {
      for (let index = 0; index < shape.inputCount / 4; index++) {
        preactInputs[index]!.value = preactTick;
      }
    });
    void preactProbe.textContent;
  }, repetitionsFor(stats.computedCount));
  render(null, preactSandbox);
  preactSandbox.remove();

  return {
    size: stats.computedCount,
    simdMs: simd.median,
    preactMs: preact.median,
    simdP95Ms: simd.p95,
    preactP95Ms: preact.p95,
    simdMountMs,
    preactMountMs,
    simdDetail: `${shape.width.toLocaleString()} wide × ${shape.depth.toLocaleString()} deep / ${
      formatBytes(stats.denseMatrixBytes)
    } dense (was ${formatBytes(stats.fullDenseMatrixBytes)}) / ${dispatch}`,
  };
}

async function compareFanout(size: number): Promise<Comparison> {
  const signalCount = 16;
  const dependenciesPerBinding = 8;
  const simdSandbox = sandbox();
  const ui = new SimdUi({ document: uiDocument });
  const inputs = Array.from({ length: signalCount }, () => ui.signal(0));
  const children: UiNode[] = [];
  for (let effectId = 0; effectId < size; effectId++) {
    const dependencies = dependencySet(inputs, effectId, dependenciesPerBinding);
    children.push(ui.element("span", {}, [ui.text(dependencies, () => sumSignals(dependencies))]));
  }
  const simdRoot = ui.element("div", {}, children);
  const simdMountStart = performance.now();
  await ui.mount(asContainer(simdSandbox), simdRoot);
  const simdMountMs = performance.now() - simdMountStart;
  const simdProbe = simdSandbox.querySelector("span:last-child")!;
  let simdTick = 0;
  const simd = measureSamples(() => {
    simdTick++;
    ui.batch(() => {
      for (let index = 0; index < signalCount / 2; index++) inputs[index]!.value = simdTick;
    });
    void simdProbe.textContent;
  }, repetitionsFor(size));
  const dispatch = ui.stats.lastDispatchStrategy ?? "none";
  ui.destroy();
  simdSandbox.remove();

  const preactSandbox = sandbox();
  const preactInputs = Array.from({ length: signalCount }, () => signal(0));
  const outputs = Array.from({ length: size }, (_, effectId) => {
    const dependencies = dependencySet(preactInputs, effectId, dependenciesPerBinding);
    return preactComputed(() => sumSignals(dependencies));
  });
  const preactRoot = h(
    "div",
    {},
    outputs.map((output) => h("span", {}, output as unknown as ComponentChild)),
  );
  const preactMountStart = performance.now();
  render(preactRoot, preactSandbox);
  const preactMountMs = performance.now() - preactMountStart;
  const preactProbe = preactSandbox.querySelector("span:last-child")!;
  let preactTick = 0;
  const preact = measurePreactSamples(() => {
    preactTick++;
    preactBatch(() => {
      for (let index = 0; index < signalCount / 2; index++) {
        preactInputs[index]!.value = preactTick;
      }
    });
    void preactProbe.textContent;
  }, repetitionsFor(size));
  render(null, preactSandbox);
  preactSandbox.remove();
  return {
    size,
    simdMs: simd.median,
    preactMs: preact.median,
    simdP95Ms: simd.p95,
    preactP95Ms: preact.p95,
    simdMountMs,
    preactMountMs,
    simdDetail: dispatch,
  };
}

async function compareDerived(size: number): Promise<Comparison> {
  const signalCount = 16;
  const simdSandbox = sandbox();
  const ui = new SimdUi({ document: uiDocument });
  const simdInputs = Array.from({ length: signalCount }, () => ui.signal(0));
  const simdChildren = Array.from({ length: size }, (_, index) => {
    const dependencies = dependencySet(simdInputs, index, 4);
    const left = simdComputed(ui, dependencies, () => sumNumbers(dependencies));
    const right = simdComputed(ui, dependencies, () => sumNumbers(dependencies) * 2);
    const total = simdComputed(ui, [left, right], () => left.value + right.value);
    return ui.element("span", {}, [ui.text([total], () => String(total.value))]);
  });
  const simdRoot = ui.element("div", {}, simdChildren);
  const simdMountStart = performance.now();
  await ui.mount(asContainer(simdSandbox), simdRoot);
  const simdMountMs = performance.now() - simdMountStart;
  const simdProbe = simdSandbox.querySelector("span:last-child")!;
  let simdTick = 0;
  const simd = measureSamples(() => {
    simdTick++;
    ui.batch(() => {
      for (let index = 0; index < signalCount / 2; index++) {
        simdInputs[index]!.value = simdTick;
      }
    });
    void simdProbe.textContent;
  }, repetitionsFor(size));
  ui.destroy();
  simdSandbox.remove();

  const preactSandbox = sandbox();
  const preactInputs = Array.from({ length: signalCount }, () => signal(0));
  const preactOutputs = Array.from({ length: size }, (_, index) => {
    const dependencies = dependencySet(preactInputs, index, 4);
    const left = preactComputed(() => sumNumbers(dependencies));
    const right = preactComputed(() => sumNumbers(dependencies) * 2);
    return preactComputed(() => left.value + right.value);
  });
  const preactRoot = h(
    "div",
    {},
    preactOutputs.map((output) => h("span", {}, output as unknown as ComponentChild)),
  );
  const preactMountStart = performance.now();
  render(preactRoot, preactSandbox);
  const preactMountMs = performance.now() - preactMountStart;
  const preactProbe = preactSandbox.querySelector("span:last-child")!;
  let preactTick = 0;
  const preact = measurePreactSamples(() => {
    preactTick++;
    preactBatch(() => {
      for (let index = 0; index < signalCount / 2; index++) {
        preactInputs[index]!.value = preactTick;
      }
    });
    void preactProbe.textContent;
  }, repetitionsFor(size));
  render(null, preactSandbox);
  preactSandbox.remove();

  return {
    size,
    simdMs: simd.median,
    preactMs: preact.median,
    simdP95Ms: simd.p95,
    preactP95Ms: preact.p95,
    simdMountMs,
    preactMountMs,
    simdDetail: "diamond / 4 effects per output",
  };
}

async function compareComplexTree(leafCount: number): Promise<Comparison> {
  const plan = createComplexTreePlan(leafCount);
  const stats = complexTreeStats(plan);
  const simdSandbox = sandbox();
  const ui = new SimdUi({ document: uiDocument });
  const simdInputs = Array.from({ length: COMPLEX_SIGNAL_COUNT }, () => ui.signal(0));
  const simdRoot = buildSimdTree(ui, plan, simdInputs);
  const simdMountStart = performance.now();
  await ui.mount(asContainer(simdSandbox), simdRoot);
  const simdMountMs = performance.now() - simdMountStart;
  const simdElementCount = assertComplexTreeDom(simdSandbox, stats.leaves, stats.branches);
  const simdProbe = simdSandbox.querySelector(`[data-leaf="${leafCount - 1}"] small:last-child`)!;
  let simdTick = 0;
  const simd = measureSamples(() => {
    simdTick++;
    ui.batch(() => {
      for (let index = 0; index < COMPLEX_SIGNAL_COUNT / 4; index++) {
        simdInputs[index]!.value = simdTick;
      }
    });
    void simdProbe.textContent;
  }, repetitionsFor(leafCount));
  const dispatch = ui.stats.lastDispatchStrategy ?? "none";
  ui.destroy();
  simdSandbox.remove();

  const preactSandbox = sandbox();
  const preactInputs = Array.from({ length: COMPLEX_SIGNAL_COUNT }, () => signal(0));
  const preactRoot = buildPreactTree(plan, preactInputs);
  const preactMountStart = performance.now();
  render(preactRoot, preactSandbox);
  const preactMountMs = performance.now() - preactMountStart;
  const preactElementCount = assertComplexTreeDom(preactSandbox, stats.leaves, stats.branches);
  if (preactElementCount !== simdElementCount) {
    throw new Error(
      `complex tree element mismatch: SIMD=${simdElementCount}, Preact=${preactElementCount}`,
    );
  }
  const preactProbe = preactSandbox.querySelector(
    `[data-leaf="${leafCount - 1}"] small:last-child`,
  )!;
  let preactTick = 0;
  const preact = measurePreactSamples(() => {
    preactTick++;
    preactBatch(() => {
      for (let index = 0; index < COMPLEX_SIGNAL_COUNT / 4; index++) {
        preactInputs[index]!.value = preactTick;
      }
    });
    void preactProbe.textContent;
  }, repetitionsFor(leafCount));
  render(null, preactSandbox);
  preactSandbox.remove();

  return {
    size: leafCount,
    simdMs: simd.median,
    preactMs: preact.median,
    simdP95Ms: simd.p95,
    preactP95Ms: preact.p95,
    simdMountMs,
    preactMountMs,
    simdDetail: `depth ${stats.maxDepth} / ${
      leafCount * COMPLEX_BINDINGS_PER_LEAF
    } bindings / ${dispatch}`,
  };
}

function assertComplexTreeDom(host: HTMLElement, leaves: number, branches: number): number {
  const actualLeaves = host.querySelectorAll("[data-leaf]").length;
  const actualBranches = host.querySelectorAll("[data-depth]").length;
  if (actualLeaves !== leaves || actualBranches !== branches) {
    throw new Error(
      `complex tree shape mismatch: expected ${branches} branches/${leaves} leaves, ` +
        `got ${actualBranches} branches/${actualLeaves} leaves`,
    );
  }
  return host.querySelectorAll("*").length;
}

function buildSimdTree(
  ui: SimdUi,
  plan: ComplexTreeNode,
  inputs: readonly UiSignal<number>[],
): UiNode {
  if (plan.kind === "leaf") {
    const binding = (bindingIndex: number): UiNode => {
      const ids = dependencyIds(
        inputs.length,
        plan.index,
        bindingIndex,
        COMPLEX_DEPENDENCIES_PER_BINDING,
      );
      const dependencies = ids.map((signalId) => inputs[signalId]!);
      return ui.text(
        dependencies,
        () => complexBindingText(dependencies, plan.index, bindingIndex),
      );
    };
    return ui.element("article", { className: "tree-card", "data-leaf": plan.index }, [
      ui.element("header", {}, [
        ui.element("h3", {}, ["Card ", plan.index]),
        ui.element("span", { className: "tree-badge" }, [binding(0)]),
      ]),
      ui.element("div", { className: "tree-content" }, [
        ui.element("p", {}, [ui.element("strong", {}, ["Metric "]), binding(1)]),
        ui.element("p", {}, [ui.element("span", {}, ["Trend "]), binding(2)]),
      ]),
      ui.element("footer", {}, [
        ui.element("small", {}, ["Revision ", binding(3)]),
      ]),
    ]);
  }
  const tag = plan.depth === 0 ? "main" : "section";
  return ui.element(
    tag,
    { className: `tree-level-${plan.depth}`, "data-depth": plan.depth },
    plan.children.map((child) => buildSimdTree(ui, child, inputs)),
  );
}

function buildPreactTree(
  plan: ComplexTreeNode,
  inputs: readonly { readonly value: number }[],
): ComponentChild {
  if (plan.kind === "leaf") {
    const binding = (bindingIndex: number): ComponentChild => {
      const ids = dependencyIds(
        inputs.length,
        plan.index,
        bindingIndex,
        COMPLEX_DEPENDENCIES_PER_BINDING,
      );
      const dependencies = ids.map((signalId) => inputs[signalId]!);
      return preactComputed(() =>
        complexBindingText(dependencies, plan.index, bindingIndex)
      ) as unknown as ComponentChild;
    };
    return h("article", { class: "tree-card", "data-leaf": plan.index }, [
      h("header", {}, [
        h("h3", {}, ["Card ", plan.index]),
        h("span", { class: "tree-badge" }, binding(0)),
      ]),
      h("div", { class: "tree-content" }, [
        h("p", {}, [h("strong", {}, "Metric "), binding(1)]),
        h("p", {}, [h("span", {}, "Trend "), binding(2)]),
      ]),
      h("footer", {}, h("small", {}, ["Revision ", binding(3)])),
    ]);
  }
  const tag = plan.depth === 0 ? "main" : "section";
  return h(
    tag,
    { class: `tree-level-${plan.depth}`, "data-depth": plan.depth },
    plan.children.map((child) => buildPreactTree(child, inputs)),
  );
}

function complexBindingText(
  values: readonly { readonly value: number }[],
  leafIndex: number,
  bindingIndex: number,
): string {
  let result = leafIndex * 17 + bindingIndex * 13;
  for (let index = 0; index < values.length; index++) {
    result += values[index]!.value * (index + 1);
  }
  return String(result);
}

function measureSamples(
  update: () => void,
  repetitions: number,
  warmups = 5,
  iterations = 11,
): BenchmarkSummary {
  for (let index = 0; index < warmups; index++) update();
  const samples: number[] = [];
  for (let index = 0; index < iterations; index++) {
    const start = performance.now();
    for (let repeat = 0; repeat < repetitions; repeat++) update();
    samples.push((performance.now() - start) / repetitions);
  }
  return summarizeSamples(samples);
}

function measurePreactSamples(
  update: () => void,
  repetitions: number,
): BenchmarkSummary {
  const previousScheduler = preactOptions.requestAnimationFrame;
  preactOptions.requestAnimationFrame = (callback) => callback();
  try {
    return measureSamples(update, repetitions);
  } finally {
    preactOptions.requestAnimationFrame = previousScheduler;
  }
}

function repetitionsFor(size: number): number {
  if (size <= 64) return 100;
  if (size <= 512) return 30;
  if (size <= 1_024) return 10;
  return 5;
}

function dependencySet<T>(values: readonly T[], effectId: number, count: number): T[] {
  const result: T[] = [];
  for (let offset = 0; offset < count; offset++) {
    result.push(values[(effectId * 5 + offset * 3) % values.length]!);
  }
  return result;
}

function layeredDependencySet<T>(values: readonly T[], effectId: number, count: number): T[] {
  return layeredDependencyIds(values.length, effectId, count).map((signalId) => values[signalId]!);
}

function sumSignals(values: readonly { readonly value: number }[]): string {
  let sum = 0;
  for (const value of values) sum += value.value;
  return String(sum);
}

function sumNumbers(values: readonly { readonly value: number }[]): number {
  let sum = 0;
  for (const value of values) sum += value.value;
  return sum;
}

function patchScenarioDependencies<T>(
  values: readonly T[],
  plan: PatchScenarioPlan,
  bindingId: number,
): T[] {
  const dependencies: T[] = [];
  const base = bindingId * plan.dependenciesPerBinding;
  for (let offset = 0; offset < plan.dependenciesPerBinding; offset++) {
    dependencies.push(values[plan.dependencyIds[base + offset]!]!);
  }
  return dependencies;
}

function evaluatePatchScenario(
  values: readonly { readonly value: number }[],
  scenario: PatchScenario,
): number {
  return projectPatchScenarioValue(scenario, sumNumbers(values));
}

function updateSimdScenario(
  ui: SimdUi,
  inputs: readonly UiSignal<number>[],
  plan: PatchScenarioPlan,
  scenario: PatchScenario,
  tick: number,
): void {
  const update = () => {
    const value = updatePatchScenarioValue(scenario, tick);
    for (const signalId of plan.changedSignalIds) inputs[signalId]!.value = value;
  };
  if (scenario.batched) ui.batch(update);
  else update();
}

function updatePreactScenario(
  inputs: readonly { value: number }[],
  plan: PatchScenarioPlan,
  scenario: PatchScenario,
  tick: number,
): void {
  const update = () => {
    const value = updatePatchScenarioValue(scenario, tick);
    for (const signalId of plan.changedSignalIds) inputs[signalId]!.value = value;
  };
  if (scenario.batched) preactBatch(update);
  else update();
}

function patchScenarioRepetitions(size: number, scenario: PatchScenario): number {
  if (!scenario.batched) return size <= 512 ? 10 : size <= 4_096 ? 3 : 1;
  if (scenario.changedSignalCount === 1) return size <= 512 ? 100 : 50;
  if (scenario.changedSignalCount === 16) {
    return size <= 512 ? 50 : size <= 4_096 ? 20 : 5;
  }
  if (size <= 64) return 100;
  if (size <= 512) return 30;
  if (size <= 4_096) return 10;
  return 3;
}

function scenarioProbe(host: HTMLElement, plan: PatchScenarioPlan): Element {
  const bindingId = plan.changedSignalIds[plan.changedSignalIds.length - 1]!;
  const probe = host.querySelector(`span:nth-child(${bindingId + 1})`);
  if (probe === null) throw new Error("patch scenario probe missing");
  return probe;
}

function renderTable(target: HTMLElement, rows: readonly Comparison[]): void {
  target.replaceChildren(...rows.map((row) => {
    const tr = document.createElement("tr");
    const faster = row.simdMs < row.preactMs
      ? `SIMD UI ${(row.preactMs / row.simdMs).toFixed(2)}×`
      : `Preact ${(row.simdMs / row.preactMs).toFixed(2)}×`;
    tr.innerHTML = `<td>${row.size.toLocaleString()}</td><td>${
      formatResult(
        row.simdMs,
        row.simdP95Ms,
      )
    }</td><td>${
      formatResult(row.preactMs, row.preactP95Ms)
    }</td><td class="winner">${faster}</td><td>${row.simdDetail}<small>mount ${
      formatMs(row.simdMountMs)
    } / ${formatMs(row.preactMountMs)}</small></td>`;
    return tr;
  }));
}

function renderPatchTapeTable(target: HTMLElement, rows: readonly PatchTapeComparison[]): void {
  target.replaceChildren(...rows.map((row) => {
    const tr = document.createElement("tr");
    const winner = Math.min(row.directMs, row.patchMs, row.preactMs);
    const winnerName = winner === row.patchMs
      ? "Patch tape"
      : winner === row.directMs
      ? "Direct SIMD"
      : "Preact";
    tr.innerHTML = `<td>${row.size.toLocaleString()}</td><td>${
      formatResult(row.directMs, row.directP95Ms)
    }</td><td>${formatResult(row.patchMs, row.patchP95Ms)}</td><td>${
      formatResult(row.preactMs, row.preactP95Ms)
    }</td><td class="winner">${winnerName}</td><td>${row.detail}<small>patch mount ${
      formatMs(row.patchMountMs)
    }</small></td>`;
    return tr;
  }));
}

function renderPatchScenarioTable(
  target: HTMLElement,
  rows: readonly PatchScenarioComparison[],
): void {
  target.replaceChildren(...rows.map((row) => {
    const tr = document.createElement("tr");
    const winner = Math.min(row.directMs, row.patchMs, row.preactMs);
    const winnerName = winner === row.patchMs
      ? "Patch"
      : winner === row.directMs
      ? "Direct"
      : "Preact";
    const directRatio = row.directMs / row.patchMs;
    const preactRatio = row.preactMs / row.patchMs;
    tr.innerHTML =
      `<td>${row.size.toLocaleString()}</td><td>${row.label}</td><td>${row.affectedBindingCount.toLocaleString()} / ${row.flushCount} / ${row.dependenciesPerBinding}</td><td>${
        formatResult(row.directMs, row.directP95Ms)
      }</td><td>${formatResult(row.patchMs, row.patchP95Ms)}</td><td>${
        formatResult(row.preactMs, row.preactP95Ms)
      }</td><td class="winner">${winnerName}</td><td>${directRatio.toFixed(2)}× direct / ${
        preactRatio.toFixed(2)
      }× Preact / ${row.dispatch}</td>`;
    return tr;
  }));
}

function sandbox(): HTMLDivElement {
  const element = document.createElement("div");
  element.className = "bench-sandbox";
  document.body.appendChild(element);
  return element;
}

function required<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`missing #${id}`);
  return element as T;
}

function formatMs(value: number): string {
  return value < 1 ? `${(value * 1000).toFixed(1)} µs` : `${value.toFixed(3)} ms`;
}

function formatResult(median: number, p95: number): string {
  return `${formatMs(median)} <small>p95 ${formatMs(p95)}</small>`;
}

function formatBytes(value: number): string {
  if (value === 0) return "0 B";
  return value < 1024 * 1024
    ? `${(value / 1024).toFixed(1)} KiB`
    : `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
