import {
  SharedBuffer,
  SharedWaitGroup,
  SpscRingBufferU32,
  VersionedBuffer,
} from "../../packages/jsimd/src/shared-buffer/mod.ts";
import { instantiateQueryKernels } from "./kernel.ts";
import { type QueryWorkerInit, STOP_TASK } from "./protocol.ts";
import { scanAvailablePages } from "./worker_scan.ts";

self.onmessage = async (event: MessageEvent<QueryWorkerInit>) => {
  self.onmessage = null;
  try {
    using shared = await SharedBuffer.attach(event.data.memory);
    const kernels = await instantiateQueryKernels(shared.memory);
    const ring = SpscRingBufferU32.attach(shared, event.data.ringOffset);
    using consumer = ring.consumer();
    const waitGroup = SharedWaitGroup.attach(shared, event.data.waitGroupOffset);
    const snapshots = VersionedBuffer.attach(shared, event.data.snapshotOffset);
    self.postMessage({ phase: "ready", lease: shared.workerLease });

    while (true) {
      const epoch = consumer.pop();
      if (epoch === STOP_TASK) break;
      scanAvailablePages(shared, kernels, snapshots, event.data, epoch);
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
