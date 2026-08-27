import { BlockedVectorArray } from "../../packages/jsimd/src/blocked-vector-array/mod.ts";
import {
  SharedBuffer,
  SharedWaitGroup,
  SpscRingBufferU32,
} from "../../packages/jsimd/src/shared-buffer/mod.ts";
import { STOP_TASK, type VectorWorkerInit } from "./protocol.ts";

self.onmessage = async (event: MessageEvent<VectorWorkerInit>) => {
  self.onmessage = null;
  try {
    using shared = await SharedBuffer.attach(event.data.memory);
    const source = float32View(
      shared,
      event.data.datasetOffset + event.data.rowStart * event.data.dimensions * 4,
      event.data.rowCount * event.data.dimensions,
    );
    using index = BlockedVectorArray.from(
      source,
      event.data.rowCount,
      event.data.dimensions,
    );
    const ring = SpscRingBufferU32.attach(shared, event.data.ringOffset);
    using consumer = ring.consumer();
    const waitGroup = SharedWaitGroup.attach(shared, event.data.waitGroupOffset);
    const query = float32View(shared, event.data.queryOffset, event.data.dimensions);
    const localK = Math.min(event.data.k, event.data.rowCount);
    const ids = new Uint32Array(localK);
    const distances = new Float32Array(localK);
    const resultHeader = shared.uint32Array(event.data.resultOffset, 1 + event.data.k);
    const resultDistances = float32View(
      shared,
      event.data.resultOffset + (1 + event.data.k) * 4,
      event.data.k,
    );

    self.postMessage({
      phase: "ready",
      workerId: shared.workerId,
      leaseToken: shared.leaseToken,
    });

    while (true) {
      const task = consumer.pop();
      if (task === STOP_TASK) break;
      index.topKInto(query, ids, distances);
      for (let candidate = 0; candidate < localK; candidate++) {
        resultHeader[1 + candidate] = event.data.rowStart + ids[candidate]!;
        resultDistances[candidate] = distances[candidate]!;
      }
      Atomics.store(resultHeader, 0, localK);
      waitGroup.done();
    }
    self.postMessage({ phase: "stopped" });
  } catch (error) {
    self.postMessage({
      phase: "error",
      message: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  }
};

function float32View(shared: SharedBuffer, byteOffset: number, length: number): Float32Array {
  return new Float32Array(shared.memory.buffer, shared.dataOffset + byteOffset, length);
}
