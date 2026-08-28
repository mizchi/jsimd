import { ShardedBitmap, SharedBuffer } from "@mizchi/jsimd-shared";
import { instantiateParallelBloomKernels } from "./kernel.ts";
import type { ParallelBloomWorkerMessage, ParallelBloomWorkerResponse } from "./protocol.ts";

let shared: SharedBuffer | undefined;
let bitmap: ShardedBitmap | undefined;
let buildKeysOffset = 0;
let shardIndex = 0;
let addMany:
  | ((blocks: number, blockCount: number, keys: number, length: number) => void)
  | undefined;

self.onmessage = async (event: MessageEvent<ParallelBloomWorkerMessage>) => {
  const message = event.data;
  try {
    if (message.type === "init") {
      shared = await SharedBuffer.attach(message.memory, { module: message.modules.shared });
      bitmap = ShardedBitmap.attach(shared, message.bitmapOffset);
      buildKeysOffset = message.buildKeysOffset;
      shardIndex = message.shardIndex;
      addMany = instantiateParallelBloomKernels(message.modules.bloom, shared.memory).add_many;
      respond({ type: "ready" });
      return;
    }
    if (shared === undefined || bitmap === undefined || addMany === undefined) {
      throw new Error("parallel Bloom Worker is not initialized");
    }
    if (message.type === "stop") {
      shared[Symbol.dispose]();
      shared = undefined;
      respond({ type: "stopped", requestId: message.requestId });
      return;
    }
    {
      using shard = bitmap.claimShard(shardIndex);
      shard.clearAll();
      addMany(
        shared.dataOffset + bitmap.dataByteOffset + shardIndex * bitmap.shardStride,
        bitmap.capacity / 128,
        shared.dataOffset + buildKeysOffset + message.rowStart * 4,
        message.rowCount,
      );
    }
    respond({ type: "built", requestId: message.requestId });
  } catch (error) {
    respond({
      type: "error",
      requestId: "requestId" in message ? message.requestId : undefined,
      message: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  }
};

function respond(message: ParallelBloomWorkerResponse): void {
  self.postMessage(message);
}
