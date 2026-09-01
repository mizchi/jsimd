import {
  ATOMIC_INPUT_KIND,
  AtomicInputBuffer,
  type AtomicInputRecord,
  decodeAtomicInputRecord,
} from "../atomic_input.ts";
import { writeDiscretePointerEvent, writeLatestPointerEvent } from "../atomic_input_dom.ts";

interface WorkerSnapshot {
  readonly type: "snapshot";
  readonly sequence: number;
  readonly latest: number[];
  readonly discrete: number[];
  readonly count: number;
  readonly dropped: number;
}

export interface AtomicInputDemoResult {
  readonly crossOriginIsolated: boolean;
  readonly latestSequence: number;
  readonly latest: AtomicInputRecord;
  readonly discreteKinds: number[];
  readonly dropped: number;
}

export async function runAtomicInputDemo(
  host: HTMLElement,
  status: HTMLElement,
  autorun: boolean,
): Promise<AtomicInputDemoResult | null> {
  const input = AtomicInputBuffer.create(64);
  const worker = new Worker(new URL("./input_demo_worker.ts", import.meta.url), { type: "module" });
  await request(worker, { type: "init", buffer: input.buffer }, "ready");
  const surface = document.createElement("div");
  surface.tabIndex = 0;
  surface.dataset.testid = "atomic-input-surface";
  surface.textContent = "Drag or click here";
  surface.style.cssText =
    "height:160px;display:grid;place-items:center;border:2px dashed #1f5b48;border-radius:12px;touch-action:none;user-select:none";
  host.replaceChildren(surface);

  surface.addEventListener("pointermove", (event) => {
    writeLatestPointerEvent(input, ATOMIC_INPUT_KIND.pointerMove, 1, event);
  });
  surface.addEventListener("pointerdown", (event) => {
    if (event.isTrusted) surface.setPointerCapture(event.pointerId);
    writeDiscretePointerEvent(input, ATOMIC_INPUT_KIND.pointerDown, 1, event);
  });
  surface.addEventListener("pointerup", (event) => {
    writeDiscretePointerEvent(input, ATOMIC_INPUT_KIND.pointerUp, 1, event);
  });
  surface.addEventListener("pointercancel", (event) => {
    writeDiscretePointerEvent(input, ATOMIC_INPUT_KIND.pointerCancel, 1, event);
  });
  surface.addEventListener("click", (event) => {
    writeDiscretePointerEvent(input, ATOMIC_INPUT_KIND.click, 1, event);
  });

  if (!autorun) {
    status.textContent = "Atomic input ready: drag or click the surface";
    return null;
  }
  for (let index = 0; index < 100; index++) {
    surface.dispatchEvent(pointerEvent("pointermove", index + 0.5, index + 0.25, 1));
  }
  surface.dispatchEvent(pointerEvent("pointerdown", 99.5, 99.25, 1));
  surface.dispatchEvent(pointerEvent("pointerup", 99.5, 99.25, 0));
  surface.dispatchEvent(pointerEvent("click", 99.5, 99.25, 0));
  const snapshot = await request(worker, { type: "snapshot" }, "snapshot") as WorkerSnapshot;
  const latestWords = Int32Array.from(snapshot.latest);
  const discreteWords = Int32Array.from(snapshot.discrete);
  const latest = decodeAtomicInputRecord(latestWords);
  const discreteKinds = Array.from(
    { length: snapshot.count },
    (_, record) => decodeAtomicInputRecord(discreteWords, record).kind,
  );
  if (
    latest.xFixed !== Math.round(99.5 * 64) ||
    discreteKinds.join(",") !== [
        ATOMIC_INPUT_KIND.pointerDown,
        ATOMIC_INPUT_KIND.pointerUp,
        ATOMIC_INPUT_KIND.click,
      ].join(",")
  ) {
    throw new Error("atomic input browser round-trip mismatch");
  }
  status.textContent = "Atomic input complete: 100 moves coalesced, 3 discrete events preserved";
  worker.terminate();
  return {
    crossOriginIsolated,
    latestSequence: snapshot.sequence,
    latest,
    discreteKinds,
    dropped: snapshot.dropped,
  };
}

function pointerEvent(
  type: string,
  clientX: number,
  clientY: number,
  buttons: number,
): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    clientX,
    clientY,
    pointerId: 17,
    buttons,
    button: 0,
    pressure: buttons === 0 ? 0 : 0.5,
    shiftKey: true,
  });
}

interface WorkerMessage {
  readonly type: string;
  readonly message?: string;
}

function request(
  worker: Worker,
  message: unknown,
  expectedType: string,
): Promise<WorkerMessage | WorkerSnapshot> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      if (event.data.type === expectedType) resolve(event.data);
      else {reject(
          new Error(event.data.message ?? `unexpected worker response: ${event.data.type}`),
        );}
    };
    worker.onerror = (event) => reject(event.error ?? new Error(event.message));
    worker.postMessage(message);
  });
}
