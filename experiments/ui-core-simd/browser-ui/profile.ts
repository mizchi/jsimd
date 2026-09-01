import { batch as preactBatch, computed as preactComputed, signal } from "@preact/signals";
import { type ComponentChild, h, options as preactOptions, render } from "preact";
import { AtomicEffectBatch } from "../atomic_effect_batch.ts";
import { summarizeSamples } from "../benchmark_stats.ts";
import { estimatePackedGraphMemory } from "../diagnostics.ts";
import { applyTextI32Batch, NumericPatchTape, type PatchBinding } from "../patch_tape.ts";
import {
  estimateAtomicBridgeBytes,
  type InteractionSample,
  summarizeInteractionSamples,
  validateProfileBindingCount,
} from "../runtime_profile.ts";
import { SimdUi, type UiContainer, type UiDocument, type UiNode } from "../signals.ts";

const SIGNAL_COUNT = 64;
const DEPENDENCIES_PER_BINDING = 8;
const WORKER_COUNT = 4;
const SAMPLE_COUNT = 11;
const WARMUP_COUNT = 5;

export type ProfileRuntime = "direct" | "patch" | "preact" | "atomics";

interface UpdateMetrics {
  readonly workerMs: number;
  readonly commitMs: number;
}

interface ProfileFixture {
  readonly probe: CharacterData;
  readonly knownBackingBytes: number | null;
  update(tick: number): UpdateMetrics | Promise<UpdateMetrics>;
  cleanup(): void;
}

export interface RuntimeProfileReport {
  readonly size: number;
  readonly runtime: ProfileRuntime;
  readonly crossOriginIsolated: boolean;
  readonly memoryMethod: "measureUserAgentSpecificMemory" | "performance.memory" | "unavailable";
  readonly memoryBeforeBytes: number | null;
  readonly memoryMountedBytes: number | null;
  readonly memoryDeltaBytes: number | null;
  readonly knownBackingBytes: number | null;
  readonly samples: number;
  readonly inputDelayMs: number;
  readonly inputDelayP95Ms: number;
  readonly eventLoopDelayMs: number;
  readonly eventLoopDelayP95Ms: number;
  readonly idleEventLoopMs: number;
  readonly eventLoopBlockMs: number;
  readonly mainThreadMs: number;
  readonly mainThreadP95Ms: number;
  readonly workerMs: number;
  readonly commitMs: number;
  readonly eventToDomMs: number;
  readonly eventToDomP95Ms: number;
}

export interface RuntimeProfilePageOptions {
  readonly size: number;
  readonly runtime: ProfileRuntime;
  readonly document: UiDocument;
  readonly host: HTMLElement;
  readonly button: HTMLButtonElement;
  readonly status: HTMLElement;
  readonly autorun?: boolean;
  readonly report: (result: RuntimeProfileReport) => void;
}

export async function mountRuntimeProfilePage(options: RuntimeProfilePageOptions): Promise<void> {
  const size = validateProfileBindingCount(options.size);
  const memoryBefore = await measureMemory();
  options.status.textContent = `Mounting ${options.runtime}: ${size.toLocaleString()} bindings…`;
  const fixture = await createFixture(options.runtime, size, options.document, options.host);
  window.addEventListener("pagehide", () => fixture.cleanup(), { once: true });
  for (let tick = 1; tick <= WARMUP_COUNT; tick++) await fixture.update(tick);
  const memoryMounted = await measureMemory();
  const idleEventLoopSamples: number[] = [];
  for (let index = 0; index < SAMPLE_COUNT; index++) {
    idleEventLoopSamples.push(await scheduleEventLoopProbe());
  }
  const idleEventLoop = summarizeSamples(idleEventLoopSamples);
  const samples: InteractionSample[] = [];
  let tick = WARMUP_COUNT;
  options.button.textContent = `Profile ${options.runtime} update`;
  options.button.dataset.testid = "profile-update";
  options.status.textContent =
    `Ready: click ${SAMPLE_COUNT} times (${options.runtime}, ${size.toLocaleString()} bindings)`;

  options.button.addEventListener("click", (event) => {
    void recordInteraction(event);
  });
  if (options.autorun) {
    options.button.disabled = true;
    for (let index = 0; index < SAMPLE_COUNT; index++) await recordAutomatedInteraction();
  }

  async function recordInteraction(event: MouseEvent): Promise<void> {
    options.button.disabled = true;
    const eventLoopDelay = scheduleEventLoopProbe();
    const handlerStart = performance.now();
    const inputDelayMs = Math.max(0, handlerStart - event.timeStamp);
    await performUpdate(event.timeStamp, inputDelayMs, eventLoopDelay);
  }

  async function recordAutomatedInteraction(): Promise<void> {
    const eventStarted = performance.now();
    const eventLoopDelay = scheduleEventLoopProbe();
    await performUpdate(eventStarted, 0, eventLoopDelay);
  }

  async function performUpdate(
    eventStarted: number,
    inputDelayMs: number,
    eventLoopDelay: Promise<number>,
  ): Promise<void> {
    const handlerStart = performance.now();
    const updateResult = fixture.update(++tick);
    const asynchronous = updateResult instanceof Promise;
    const dispatchMs = performance.now() - handlerStart;
    const metrics = await updateResult;
    const mainThreadMs = dispatchMs + (asynchronous ? metrics.commitMs : 0);
    const eventToDomMs = performance.now() - eventStarted;
    const expected = String(tick * DEPENDENCIES_PER_BINDING);
    if (fixture.probe.data !== expected) {
      throw new Error(`profile DOM mismatch: expected ${expected}, got ${fixture.probe.data}`);
    }
    samples.push({
      inputDelayMs,
      eventLoopDelayMs: await eventLoopDelay,
      mainThreadMs,
      workerMs: metrics.workerMs,
      commitMs: metrics.commitMs,
      eventToDomMs,
    });
    options.status.textContent =
      `Profile samples: ${samples.length}/${SAMPLE_COUNT} (${options.runtime})`;
    if (samples.length < SAMPLE_COUNT) {
      if (!options.autorun) options.button.disabled = false;
      return;
    }
    const summary = summarizeInteractionSamples(samples);
    const memoryDeltaBytes = memoryBefore.bytes === null || memoryMounted.bytes === null
      ? null
      : memoryMounted.bytes - memoryBefore.bytes;
    options.report({
      size,
      runtime: options.runtime,
      crossOriginIsolated,
      memoryMethod: memoryMounted.method,
      memoryBeforeBytes: memoryBefore.bytes,
      memoryMountedBytes: memoryMounted.bytes,
      memoryDeltaBytes,
      knownBackingBytes: fixture.knownBackingBytes,
      samples: samples.length,
      inputDelayMs: summary.inputDelay.median,
      inputDelayP95Ms: summary.inputDelay.p95,
      eventLoopDelayMs: summary.eventLoopDelay.median,
      eventLoopDelayP95Ms: summary.eventLoopDelay.p95,
      idleEventLoopMs: idleEventLoop.median,
      eventLoopBlockMs: Math.max(0, summary.eventLoopDelay.median - idleEventLoop.median),
      mainThreadMs: summary.mainThread.median,
      mainThreadP95Ms: summary.mainThread.p95,
      workerMs: summary.worker.median,
      commitMs: summary.commit.median,
      eventToDomMs: summary.eventToDom.median,
      eventToDomP95Ms: summary.eventToDom.p95,
    });
    options.status.textContent = `Complete: ${options.runtime}, ${size.toLocaleString()} bindings`;
  }
}

function scheduleEventLoopProbe(): Promise<number> {
  const started = performance.now();
  const taskScheduler = (window as Window & {
    scheduler?: {
      postTask<T>(callback: () => T, options: { priority: "user-blocking" }): Promise<T>;
    };
  }).scheduler;
  if (taskScheduler !== undefined) {
    return taskScheduler.postTask(
      () => performance.now() - started,
      { priority: "user-blocking" },
    );
  }
  const channel = new MessageChannel();
  return new Promise((resolve) => {
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve(performance.now() - started);
    };
    channel.port2.postMessage(null);
  });
}

async function createFixture(
  runtime: ProfileRuntime,
  size: number,
  document: UiDocument,
  host: HTMLElement,
): Promise<ProfileFixture> {
  switch (runtime) {
    case "direct":
      return await createDirectFixture(size, document, host);
    case "patch":
      return await createPatchFixture(size, document, host);
    case "preact":
      return createPreactFixture(size, host);
    case "atomics":
      return await createAtomicFixture(size, document, host);
  }
}

async function createDirectFixture(
  size: number,
  document: UiDocument,
  host: HTMLElement,
): Promise<ProfileFixture> {
  const ui = new SimdUi({ document });
  const inputs = Array.from({ length: SIGNAL_COUNT }, () => ui.signal(0));
  const children: UiNode[] = Array.from({ length: size }, (_, bindingId) => {
    const dependencies = dependenciesFor(inputs, bindingId);
    return ui.element("span", {}, [ui.text(dependencies, () => String(sum(dependencies)))]);
  });
  await ui.mount(host as unknown as UiContainer, ui.element("div", {}, children));
  const probe = profileProbe(host, size);
  const estimate = estimatePackedGraphMemory(
    SIGNAL_COUNT,
    size,
    size * DEPENDENCIES_PER_BINDING,
    SIGNAL_COUNT,
  );
  return {
    probe,
    knownBackingBytes: estimate.totalBytes,
    update(tick) {
      const started = performance.now();
      ui.batch(() => {
        for (const input of inputs) input.value = tick;
      });
      return { workerMs: 0, commitMs: performance.now() - started };
    },
    cleanup: () => ui.destroy(),
  };
}

async function createPatchFixture(
  size: number,
  document: UiDocument,
  host: HTMLElement,
): Promise<ProfileFixture> {
  const ui = new SimdUi({ document });
  const inputs = Array.from({ length: SIGNAL_COUNT }, () => ui.signal(0));
  const bindings: PatchBinding[] = Array.from(
    { length: size },
    (_, target) => ({ kind: "text-i32", target }),
  );
  const tape = await NumericPatchTape.create(bindings);
  const targets: CharacterData[] = [];
  const children: UiNode[] = [];
  for (let bindingId = 0; bindingId < size; bindingId++) {
    const dependencies = dependenciesFor(inputs, bindingId);
    const text = document.createTextNode("") as unknown as CharacterData;
    targets.push(text);
    ui.effect(dependencies, () => tape.i32Values[bindingId] = sum(dependencies));
    children.push(ui.element("span", {}, [text]));
  }
  ui.effect(inputs, () => applyTextI32Batch(tape.drain(), targets));
  await ui.mount(host as unknown as UiContainer, ui.element("div", {}, children));
  const probe = profileProbe(host, size);
  const graph = estimatePackedGraphMemory(
    SIGNAL_COUNT,
    size + 1,
    size * DEPENDENCIES_PER_BINDING + SIGNAL_COUNT,
    SIGNAL_COUNT,
  );
  const tapeBytes = Math.ceil(size * 16 / 65_536) * 65_536;
  return {
    probe,
    knownBackingBytes: graph.totalBytes + tapeBytes,
    update(tick) {
      const started = performance.now();
      ui.batch(() => {
        for (const input of inputs) input.value = tick;
      });
      return { workerMs: 0, commitMs: performance.now() - started };
    },
    cleanup: () => ui.destroy(),
  };
}

function createPreactFixture(size: number, host: HTMLElement): ProfileFixture {
  const inputs = Array.from({ length: SIGNAL_COUNT }, () => signal(0));
  const outputs = Array.from({ length: size }, (_, bindingId) => {
    const dependencies = dependenciesFor(inputs, bindingId);
    return preactComputed(() => sum(dependencies));
  });
  render(
    h(
      "div",
      {},
      outputs.map((output) => h("span", {}, output as unknown as ComponentChild)),
    ),
    host,
  );
  const probe = profileProbe(host, size);
  const previousScheduler = preactOptions.requestAnimationFrame;
  preactOptions.requestAnimationFrame = (callback) => callback();
  return {
    probe,
    knownBackingBytes: null,
    update(tick) {
      const started = performance.now();
      preactBatch(() => {
        for (const input of inputs) input.value = tick;
      });
      return { workerMs: 0, commitMs: performance.now() - started };
    },
    cleanup() {
      preactOptions.requestAnimationFrame = previousScheduler;
      render(null, host);
    },
  };
}

async function createAtomicFixture(
  size: number,
  document: UiDocument,
  host: HTMLElement,
): Promise<ProfileFixture> {
  const batch = AtomicEffectBatch.create(size);
  const valueBuffer = new SharedArrayBuffer(size * Int32Array.BYTES_PER_ELEMENT);
  const values = new Int32Array(valueBuffer);
  const targets: CharacterData[] = [];
  const root = document.createElement("div");
  for (let bindingId = 0; bindingId < size; bindingId++) {
    const span = document.createElement("span");
    const text = document.createTextNode("0") as unknown as CharacterData;
    targets.push(text);
    span.appendChild(text as unknown as UiNode);
    root.appendChild(span);
  }
  host.append(root as unknown as Node);
  const workers = Array.from(
    { length: WORKER_COUNT },
    () => new Worker(new URL("./atomic_profile_worker.ts", import.meta.url), { type: "module" }),
  );
  await Promise.all(workers.map((worker, workerId) =>
    requestWorker(worker, {
      type: "init",
      batchBuffer: batch.buffer,
      valueBuffer,
      bindingCount: size,
      workerId,
      workerCount: WORKER_COUNT,
    }, "ready")
  ));
  let sequence = 0;
  return {
    probe: targets[size - 1]!,
    knownBackingBytes: estimateAtomicBridgeBytes(size).totalBytes,
    async update(tick) {
      const workerStarted = performance.now();
      const currentSequence = ++sequence;
      await Promise.all(workers.map((worker) =>
        requestWorker(
          worker,
          { type: "run", sequence: currentSequence, value: tick * DEPENDENCIES_PER_BINDING },
          "done",
          currentSequence,
        )
      ));
      const workerMs = performance.now() - workerStarted;
      const commitStarted = performance.now();
      const ids = batch.drain();
      for (const bindingId of ids) {
        targets[bindingId]!.data = String(Atomics.load(values, bindingId));
      }
      return { workerMs, commitMs: performance.now() - commitStarted };
    },
    cleanup() {
      for (const worker of workers) worker.terminate();
      (root as unknown as Element).remove();
    },
  };
}

function dependenciesFor<T>(inputs: readonly T[], bindingId: number): T[] {
  const dependencies: T[] = [];
  for (let offset = 0; offset < DEPENDENCIES_PER_BINDING; offset++) {
    dependencies.push(inputs[(bindingId * 5 + offset * 7) % inputs.length]!);
  }
  return dependencies;
}

function sum(values: readonly { readonly value: number }[]): number {
  let result = 0;
  for (const value of values) result += value.value;
  return result;
}

function profileProbe(host: HTMLElement, size: number): CharacterData {
  const probe = host.querySelector(`span:nth-child(${size})`)?.firstChild;
  if (!(probe instanceof CharacterData)) throw new Error("profile probe missing");
  return probe;
}

interface WorkerResponse {
  readonly type: string;
  readonly sequence?: number;
  readonly message?: string;
}

function requestWorker(
  worker: Worker,
  message: unknown,
  expectedType: string,
  expectedSequence?: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (
        event.data.type === expectedType &&
        (expectedSequence === undefined || event.data.sequence === expectedSequence)
      ) {
        resolve();
      } else {
        reject(new Error(event.data.message ?? `unexpected worker response: ${event.data.type}`));
      }
    };
    worker.onerror = (event) => reject(event.error ?? new Error(event.message));
    worker.postMessage(message);
  });
}

type MemoryMethod = RuntimeProfileReport["memoryMethod"];

interface MemoryMeasurement {
  readonly bytes: number | null;
  readonly method: MemoryMethod;
}

async function measureMemory(): Promise<MemoryMeasurement> {
  const extended = performance as Performance & {
    measureUserAgentSpecificMemory?: () => Promise<{ readonly bytes: number }>;
    memory?: { readonly usedJSHeapSize: number };
  };
  if (typeof extended.measureUserAgentSpecificMemory === "function") {
    const measurement = await extended.measureUserAgentSpecificMemory();
    return { bytes: measurement.bytes, method: "measureUserAgentSpecificMemory" };
  }
  if (typeof extended.memory?.usedJSHeapSize === "number") {
    return { bytes: extended.memory.usedJSHeapSize, method: "performance.memory" };
  }
  return { bytes: null, method: "unavailable" };
}
