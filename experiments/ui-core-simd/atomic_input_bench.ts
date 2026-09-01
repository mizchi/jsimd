import { ATOMIC_INPUT_KIND, AtomicInputBuffer } from "./atomic_input.ts";

const WRITE_COUNT = 4_096;
const latest = AtomicInputBuffer.create(1_024);
const ring = AtomicInputBuffer.create(4_096);
const drain = new Int32Array(4_096 * 8);
const local = new Int32Array(8);

Deno.bench("atomic input: local 8-word latest baseline", { group: "atomic-input" }, () => {
  for (let index = 0; index < WRITE_COUNT; index++) {
    local[0] = ATOMIC_INPUT_KIND.pointerMove;
    local[1] = 7;
    local[2] = index;
    local[3] = -index;
    local[4] = 1;
    local[5] = 1;
    local[6] = index;
    local[7] = 0;
  }
});

Deno.bench("atomic input: publish latest pointer", { group: "atomic-input" }, () => {
  for (let index = 0; index < WRITE_COUNT; index++) {
    latest.publishLatest(ATOMIC_INPUT_KIND.pointerMove, 7, index, -index, 1, 1, index, 0);
  }
});

Deno.bench("atomic input: push and drain discrete ring", { group: "atomic-input" }, () => {
  for (let index = 0; index < WRITE_COUNT; index++) {
    ring.push(ATOMIC_INPUT_KIND.click, 7, index, -index, 1, 1, index, 0);
  }
  ring.drainInto(drain);
});
