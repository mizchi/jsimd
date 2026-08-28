import {
  SharedBuffer,
  SharedWaitGroup,
  SpscRingBufferU32,
  VersionedBuffer,
} from "@mizchi/jsimd-shared";
import { instantiateQueryKernels } from "./kernel.ts";
import { GROUP_STOP_TASK, type GroupQueryWorkerInit } from "./group_protocol.ts";
import { scanAvailableGroupPages } from "./group_worker_scan.ts";

self.onmessage = async (event: MessageEvent<GroupQueryWorkerInit>) => {
  self.onmessage = null;
  try {
    using shared = await SharedBuffer.attach(event.data.memory, {
      module: event.data.modules.shared,
    });
    const kernels = await instantiateQueryKernels(shared.memory, event.data.modules.query);
    const ring = SpscRingBufferU32.attach(shared, event.data.ringOffset);
    using consumer = ring.consumer();
    const waitGroup = SharedWaitGroup.attach(shared, event.data.waitGroupOffset);
    const snapshots = VersionedBuffer.attach(shared, event.data.snapshotOffset);
    self.postMessage({ phase: "ready", lease: shared.workerLease });

    while (true) {
      const epoch = consumer.pop();
      if (epoch === GROUP_STOP_TASK) break;
      scanAvailableGroupPages(shared, kernels, snapshots, event.data, epoch);
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
