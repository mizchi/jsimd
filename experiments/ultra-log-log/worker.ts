import type { UltraLogLogWorkerMessage, UltraLogLogWorkerResponse } from "./protocol.ts";
import { UltraLogLogWorkspace } from "./workspace.ts";

let shared: SharedArrayBuffer | undefined;
let valuesOffset = 0;
let stateOffset = 0;
let workspace: UltraLogLogWorkspace | undefined;

self.onmessage = async (event: MessageEvent<UltraLogLogWorkerMessage>) => {
  const message = event.data;
  try {
    if (message.type === "init") {
      shared = message.shared;
      valuesOffset = message.valuesOffset;
      stateOffset = message.statesOffset + message.stateOffset;
      workspace = await UltraLogLogWorkspace.create({
        precision: message.precision,
        maxValues: message.maxValues,
        shardCapacity: 1,
      });
      respond({ type: "ready" });
      return;
    }
    if (shared === undefined || workspace === undefined) {
      throw new Error("UltraLogLog Worker is not initialized");
    }
    if (message.type === "stop") {
      await workspace[Symbol.asyncDispose]();
      workspace = undefined;
      shared = undefined;
      respond({ type: "stopped", requestId: message.requestId });
      return;
    }
    const values = new Uint32Array(
      shared,
      valuesOffset + message.rowStart * Uint32Array.BYTES_PER_ELEMENT,
      message.rowCount,
    );
    workspace.buildShard(0, values);
    workspace.shardStateInto(
      0,
      new Uint8Array(shared, stateOffset, workspace.registerCount),
    );
    respond({ type: "built", requestId: message.requestId });
  } catch (error) {
    respond({
      type: "error",
      requestId: "requestId" in message ? message.requestId : undefined,
      message: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  }
};

function respond(message: UltraLogLogWorkerResponse): void {
  self.postMessage(message);
}
