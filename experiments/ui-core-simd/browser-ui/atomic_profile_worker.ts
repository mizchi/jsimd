import { AtomicEffectBatch } from "../atomic_effect_batch.ts";

let batch: AtomicEffectBatch;
let values: Int32Array;
let bindingCount = 0;
let bindingStart = 0;
let bindingEnd = 0;

self.onmessage = (event: MessageEvent<InitMessage | RunMessage>) => {
  try {
    if (event.data.type === "init") {
      batch = AtomicEffectBatch.attach(event.data.batchBuffer);
      values = new Int32Array(event.data.valueBuffer);
      bindingCount = event.data.bindingCount;
      bindingStart = Math.floor(bindingCount * event.data.workerId / event.data.workerCount);
      bindingEnd = Math.floor(bindingCount * (event.data.workerId + 1) / event.data.workerCount);
      self.postMessage({ type: "ready" });
      return;
    }
    for (let bindingId = bindingStart; bindingId < bindingEnd; bindingId++) {
      Atomics.store(values, bindingId, event.data.value);
      batch.mark(bindingId);
    }
    self.postMessage({ type: "done", sequence: event.data.sequence });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  }
};

interface InitMessage {
  readonly type: "init";
  readonly batchBuffer: SharedArrayBuffer;
  readonly valueBuffer: SharedArrayBuffer;
  readonly bindingCount: number;
  readonly workerId: number;
  readonly workerCount: number;
}

interface RunMessage {
  readonly type: "run";
  readonly sequence: number;
  readonly value: number;
}
