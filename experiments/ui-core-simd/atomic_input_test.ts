import {
  ATOMIC_INPUT_KIND,
  ATOMIC_INPUT_RECORD_WORDS,
  AtomicInputBuffer,
  decodeAtomicInputRecord,
} from "./atomic_input.ts";
import { writeDiscretePointerEvent, writeLatestPointerEvent } from "./atomic_input_dom.ts";

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

Deno.test("latest pointer slot coalesces moves without allocating records", () => {
  const owner = AtomicInputBuffer.create(4);
  const peer = AtomicInputBuffer.attach(owner.buffer);
  const output = new Int32Array(ATOMIC_INPUT_RECORD_WORDS);
  owner.publishLatest(ATOMIC_INPUT_KIND.pointerMove, 7, 640, -128, 3, 5, 1234, 9);
  assertEquals(owner.wakeSequence, 1, "latest wakes consumer");
  const firstSequence = peer.readLatestInto(output);
  assertEquals(firstSequence, 2, "first published sequence");
  owner.publishLatest(ATOMIC_INPUT_KIND.pointerMove, 7, 704, -64, 3, 5, 1240, 10);
  assertEquals(owner.wakeSequence, 2, "coalesced update wakes consumer");
  const secondSequence = peer.readLatestInto(output);
  assertEquals(secondSequence, 4, "second published sequence");
  const decoded = decodeAtomicInputRecord(output);
  assertEquals(decoded.xFixed, 704, "latest x");
  assertEquals(decoded.yFixed, -64, "latest y");
  assertEquals(decoded.timeMicros, 1240, "latest timestamp");
});

Deno.test("discrete ring preserves FIFO order and counts overflow", () => {
  const input = AtomicInputBuffer.create(2);
  assertEquals(
    input.push(ATOMIC_INPUT_KIND.pointerDown, 1, 10, 20, 4, 0, 100, 0),
    true,
    "first push",
  );
  assertEquals(
    input.push(ATOMIC_INPUT_KIND.click, 2, 30, 40, 4, 0, 200, 0),
    true,
    "second push",
  );
  assertEquals(input.wakeSequence, 2, "discrete pushes share wake sequence");
  assertEquals(
    input.push(ATOMIC_INPUT_KIND.pointerUp, 3, 50, 60, 4, 0, 300, 0),
    false,
    "full ring drops",
  );
  assertEquals(input.droppedCount, 1, "drop counter");
  const output = new Int32Array(ATOMIC_INPUT_RECORD_WORDS * 2);
  assertEquals(input.drainInto(output), 2, "drain count");
  assertEquals(decodeAtomicInputRecord(output, 0).kind, ATOMIC_INPUT_KIND.pointerDown, "FIFO 0");
  assertEquals(decodeAtomicInputRecord(output, 1).kind, ATOMIC_INPUT_KIND.click, "FIFO 1");
  assertEquals(
    input.push(ATOMIC_INPUT_KIND.pointerUp, 3, 50, 60, 4, 0, 300, 0),
    true,
    "ring wraps after drain",
  );
});

Deno.test("DOM adapter extracts only packed pointer data", () => {
  const input = AtomicInputBuffer.create(4);
  const event = {
    clientX: 10.25,
    clientY: -2.5,
    pointerId: 42,
    buttons: 3,
    button: 0,
    shiftKey: true,
    ctrlKey: false,
    altKey: true,
    metaKey: false,
    timeStamp: 12.345,
    pressure: 0.5,
    detail: 2,
  };
  writeLatestPointerEvent(input, ATOMIC_INPUT_KIND.pointerMove, 99, event);
  assertEquals(
    writeDiscretePointerEvent(input, ATOMIC_INPUT_KIND.click, 99, event),
    true,
    "click queued",
  );
  const output = new Int32Array(ATOMIC_INPUT_RECORD_WORDS);
  input.readLatestInto(output);
  const latest = decodeAtomicInputRecord(output);
  assertEquals(latest.targetId, 99, "target ID");
  assertEquals(latest.xFixed, 656, "1/64 CSS px x");
  assertEquals(latest.yFixed, -160, "1/64 CSS px y");
  assertEquals(latest.pointerId, 42, "pointer ID");
  assertEquals(latest.buttons, 3, "buttons");
  assertEquals(latest.shiftKey, true, "shift modifier");
  assertEquals(latest.altKey, true, "alt modifier");
  assertEquals(latest.timeMicros, 12_345, "microsecond timestamp");
});

Deno.test("shared wake sequence releases a blocking Worker consumer", async () => {
  const input = AtomicInputBuffer.create(4);
  const moduleUrl = new URL("./atomic_input.ts", import.meta.url).href;
  const workerUrl = URL.createObjectURL(
    new Blob([
      `import { AtomicInputBuffer } from ${JSON.stringify(moduleUrl)};
self.onmessage = (event) => {
  const input = AtomicInputBuffer.attach(event.data);
  self.postMessage({ type: "ready" });
  const result = input.waitForInput(input.wakeSequence, 1000);
  const record = new Int32Array(8);
  const sequence = input.readLatestInto(record);
  self.postMessage({ type: "done", result, sequence, x: record[2] });
};`,
    ], { type: "text/javascript" }),
  );
  const worker = new Worker(workerUrl, { type: "module" });
  try {
    const done = new Promise<{ result: string; sequence: number; x: number }>((resolve, reject) => {
      worker.onmessage = (event) => {
        if (event.data.type === "ready") {
          input.publishLatest(ATOMIC_INPUT_KIND.pointerMove, 1, 123, 0, 1, 0, 1, 0);
        } else resolve(event.data);
      };
      worker.onerror = (event) => reject(event.error ?? new Error(event.message));
    });
    worker.postMessage(input.buffer);
    const result = await done;
    assertEquals(result.result, "ok", "worker wake result");
    assertEquals(result.sequence, 2, "worker sees publication");
    assertEquals(result.x, 123, "worker reads record after wake");
  } finally {
    worker.terminate();
    URL.revokeObjectURL(workerUrl);
  }
});

Deno.test("atomic input validates power-of-two capacity and destinations", () => {
  assertThrows(() => AtomicInputBuffer.create(3), RangeError);
  const input = AtomicInputBuffer.create(4);
  assertThrows(() => input.readLatestInto(new Int32Array(7)), RangeError);
  assertThrows(() => input.drainInto(new Int32Array(7)), RangeError);
  assertThrows(() => AtomicInputBuffer.attach(new SharedArrayBuffer(64)), RangeError);
});

function assertThrows(operation: () => unknown, constructor: typeof Error): void {
  try {
    operation();
  } catch (error) {
    if (error instanceof constructor) return;
    throw error;
  }
  throw new Error(`expected ${constructor.name}`);
}
