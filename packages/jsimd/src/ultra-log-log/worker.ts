import { UltraLogLogU32 } from "./core.ts";
import type { UltraLogLogWorkerMessage, UltraLogLogWorkerResponse } from "./protocol.ts";

interface MessagePortLike {
  postMessage(message: UltraLogLogWorkerResponse): void;
  on?(event: "message", listener: (message: UltraLogLogWorkerMessage) => void): void;
}

let shared: SharedArrayBuffer | undefined;
let valuesOffset = 0;
let stateOffset = 0;
let sketch: UltraLogLogU32 | undefined;
let port: MessagePortLike;

function handleMessage(message: UltraLogLogWorkerMessage): void {
  try {
    if (message.type === "init") {
      shared = message.shared;
      valuesOffset = message.valuesOffset;
      stateOffset = message.statesOffset + message.stateOffset;
      sketch = new UltraLogLogU32(message.precision);
      respond({ type: "ready" });
      return;
    }
    if (shared === undefined || sketch === undefined) {
      throw new Error("UltraLogLog Worker is not initialized");
    }
    if (message.type === "stop") {
      sketch[Symbol.dispose]();
      sketch = undefined;
      shared = undefined;
      respond({ type: "stopped", requestId: message.requestId });
      return;
    }
    const values = new Uint32Array(shared, valuesOffset + message.rowStart * 4, message.rowCount);
    sketch.replace(values);
    sketch.stateInto(new Uint8Array(shared, stateOffset, sketch.registerCount));
    respond({ type: "built", requestId: message.requestId });
  } catch (error) {
    respond({
      type: "error",
      requestId: "requestId" in message ? message.requestId : undefined,
      message: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  }
}

function respond(message: UltraLogLogWorkerResponse): void {
  port.postMessage(message);
}

const webWorker = globalThis as typeof globalThis & {
  postMessage?: (message: UltraLogLogWorkerResponse) => void;
  onmessage?: ((event: MessageEvent<UltraLogLogWorkerMessage>) => void) | null;
};
if (typeof webWorker.postMessage === "function") {
  port = { postMessage: (message) => webWorker.postMessage!(message) };
  webWorker.onmessage = (event) => handleMessage(event.data);
} else {
  const nodeWorkerThreads = "node:" + "worker_threads";
  const { parentPort } = await import(/* @vite-ignore */ nodeWorkerThreads);
  if (parentPort === null) throw new Error("UltraLogLog Node Worker has no parent port");
  port = parentPort as MessagePortLike;
  port.on!("message", handleMessage);
}
