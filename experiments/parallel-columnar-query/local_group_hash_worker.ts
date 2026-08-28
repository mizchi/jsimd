import { SharedBuffer } from "../../packages/jsimd/src/shared-buffer/mod.ts";
import { instantiateQueryKernels } from "./kernel.ts";
import type {
  LocalGroupHashWorkerMessage,
  LocalGroupHashWorkerResponse,
} from "./local_group_hash_protocol.ts";
import { LocalGroupHashTableU32 } from "./local_group_hash_table.ts";

interface WorkerScope {
  onmessage:
    | ((event: MessageEvent<LocalGroupHashWorkerMessage>) => void | Promise<void>)
    | null;
  postMessage(message: LocalGroupHashWorkerResponse): void;
  close(): void;
}

const workerScope = self as unknown as WorkerScope;
let shared: SharedBuffer | undefined;

workerScope.onmessage = async (event) => {
  if (event.data.type !== "init") return;
  workerScope.onmessage = null;
  try {
    const init = event.data;
    shared = await SharedBuffer.attach(init.memory);
    const kernels = await instantiateQueryKernels(shared.memory);
    const partial = LocalGroupHashTableU32.attach(shared, init.partialOffset);
    const output = LocalGroupHashTableU32.attach(shared, init.outputOffset);
    const sources = init.sourceOffsets.map((offset) =>
      LocalGroupHashTableU32.attach(shared!, offset)
    );
    workerScope.onmessage = (taskEvent) => {
      const task = taskEvent.data;
      if (task.type === "init") return;
      try {
        if (task.type === "aggregate") {
          partial.clear().aggregateResident(
            init.keysOffset + init.rowStart * 4,
            init.valuesOffset + init.rowStart * 4,
            init.validitiesOffset + init.rowStart,
            init.rowCount,
            kernels,
          );
          workerScope.postMessage({
            type: "result",
            requestId: task.requestId,
            pagesScanned: 0,
            pagesSkipped: 0,
          });
        } else if (task.type === "aggregateBetween") {
          if (init.filterOffset === null) {
            throw new Error("aggregateBetween requires a resident filter column");
          }
          partial.clear();
          let pagesScanned = 0;
          let pagesSkipped = 0;
          for (const page of init.pages) {
            if (
              task.minimum >= task.maximum || task.maximum <= page.minimum ||
              task.minimum > page.maximum
            ) {
              pagesSkipped++;
              continue;
            }
            partial.aggregateResidentBetween(
              init.filterOffset + page.rowStart * 4,
              init.keysOffset + page.rowStart * 4,
              init.valuesOffset + page.rowStart * 4,
              init.validitiesOffset + page.rowStart,
              page.rowCount,
              task.minimum,
              task.maximum,
              kernels,
            );
            pagesScanned++;
          }
          workerScope.postMessage({
            type: "result",
            requestId: task.requestId,
            pagesScanned,
            pagesSkipped,
          });
        } else if (task.type === "merge") {
          output.clear();
          for (const source of sources) {
            output.mergePartitionFrom(source, init.partition, init.partitionCount, kernels);
          }
          workerScope.postMessage({
            type: "result",
            requestId: task.requestId,
            pagesScanned: 0,
            pagesSkipped: 0,
          });
        } else {
          shared?.[Symbol.dispose]();
          shared = undefined;
          workerScope.postMessage({
            type: "result",
            requestId: task.requestId,
            pagesScanned: 0,
            pagesSkipped: 0,
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
