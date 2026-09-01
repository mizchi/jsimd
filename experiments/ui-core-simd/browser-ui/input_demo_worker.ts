import { ATOMIC_INPUT_RECORD_WORDS, AtomicInputBuffer } from "../atomic_input.ts";

let input: AtomicInputBuffer;
let latest: Int32Array;
let discrete: Int32Array;

self.onmessage = (event: MessageEvent<InitMessage | SnapshotMessage>) => {
  try {
    if (event.data.type === "init") {
      input = AtomicInputBuffer.attach(event.data.buffer);
      latest = new Int32Array(ATOMIC_INPUT_RECORD_WORDS);
      discrete = new Int32Array(input.capacity * ATOMIC_INPUT_RECORD_WORDS);
      self.postMessage({ type: "ready" });
      return;
    }
    const sequence = input.readLatestInto(latest);
    const count = input.drainInto(discrete);
    self.postMessage({
      type: "snapshot",
      sequence,
      latest: Array.from(latest),
      discrete: Array.from(discrete.subarray(0, count * ATOMIC_INPUT_RECORD_WORDS)),
      count,
      dropped: input.droppedCount,
    });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  }
};

interface InitMessage {
  readonly type: "init";
  readonly buffer: SharedArrayBuffer;
}

interface SnapshotMessage {
  readonly type: "snapshot";
}
