import { SharedBuffer } from "@mizchi/jsimd-shared";
import { instantiateQueryKernels } from "./kernel.ts";
import { PartitionedHashJoinTableU32 } from "./partitioned_hash_join.ts";
import type {
  PartitionedHashJoinWorkerMessage,
  PartitionedHashJoinWorkerResponse,
} from "./partitioned_hash_join_protocol.ts";

interface WorkerScope {
  onmessage:
    | ((event: MessageEvent<PartitionedHashJoinWorkerMessage>) => void | Promise<void>)
    | null;
  postMessage(message: PartitionedHashJoinWorkerResponse): void;
  close(): void;
}

const workerScope = self as unknown as WorkerScope;
let shared: SharedBuffer | undefined;

workerScope.onmessage = async (event) => {
  if (event.data.type !== "init") return;
  workerScope.onmessage = null;
  try {
    const init = event.data;
    shared = await SharedBuffer.attach(init.memory, { module: init.modules.shared });
    const kernels = await instantiateQueryKernels(shared.memory, init.modules.query);
    const table = PartitionedHashJoinTableU32.attach(shared, init.tableOffset);
    workerScope.onmessage = (taskEvent) => {
      const task = taskEvent.data;
      if (task.type === "init") return;
      try {
        if (task.type === "probe") {
          const result = table.probeResident(
            init.probeKeysOffset + init.rowStart * 4,
            init.probeRowIdsOffset + init.rowStart * 4,
            init.rowCount,
            init.outputProbeRowIdsOffset,
            init.outputBuildRowIdsOffset,
            init.outputCapacity,
            kernels,
          );
          workerScope.postMessage({ type: "result", requestId: task.requestId, ...result });
        } else {
          shared?.[Symbol.dispose]();
          shared = undefined;
          workerScope.postMessage({
            type: "result",
            requestId: task.requestId,
            matchCount: 0,
            written: 0,
            truncated: false,
          });
          workerScope.close();
        }
      } catch (error) {
        workerScope.postMessage({
          type: "error",
          requestId: task.requestId,
          message: error instanceof Error ? error.stack ?? error.message : String(error),
        });
      }
    };
    workerScope.postMessage({ type: "ready" });
  } catch (error) {
    workerScope.postMessage({
      type: "error",
      requestId: 0,
      message: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  }
};
