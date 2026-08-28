import { RoaringBitmap } from "@mizchi/jsimd/roaring-bitmap";
import type { StripedRoaringWorkerMessage, StripedRoaringWorkerResponse } from "./protocol.ts";

interface ResidentPair {
  readonly left: RoaringBitmap;
  readonly right: RoaringBitmap;
}

let pairs: ResidentPair[] | undefined;

self.onmessage = (event: MessageEvent<StripedRoaringWorkerMessage>) => {
  const message = event.data;
  try {
    if (message.type === "init") {
      if (pairs !== undefined) throw new Error("striped Roaring Worker is already initialized");
      const initialized: ResidentPair[] = [];
      try {
        for (const pair of message.pairs) {
          initialized.push(createPair(pair.left, pair.right));
        }
        pairs = initialized;
      } catch (error) {
        disposePairs(initialized);
        throw error;
      }
      respond({ type: "ready" });
      return;
    }
    if (pairs === undefined) throw new Error("striped Roaring Worker is not initialized");
    if (message.type === "stop") {
      disposePairs(pairs);
      pairs = undefined;
      respond({ type: "stopped", requestId: message.requestId });
      return;
    }
    const counts = new Float64Array(pairs.length);
    for (let index = 0; index < pairs.length; index++) {
      const pair = pairs[index]!;
      counts[index] = pair.left.andCardinality(pair.right);
    }
    respond({ type: "intersections", requestId: message.requestId, counts });
  } catch (error) {
    respond({
      type: "error",
      requestId: "requestId" in message ? message.requestId : undefined,
      message: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  }
};

function disposePairs(values: readonly ResidentPair[]): void {
  for (const pair of values) {
    pair.right[Symbol.dispose]();
    pair.left[Symbol.dispose]();
  }
}

function createPair(leftValues: Uint32Array, rightValues: Uint32Array): ResidentPair {
  const left = RoaringBitmap.from(leftValues);
  try {
    return { left, right: RoaringBitmap.from(rightValues) };
  } catch (error) {
    left[Symbol.dispose]();
    throw error;
  }
}

function respond(message: StripedRoaringWorkerResponse): void {
  self.postMessage(message);
}
