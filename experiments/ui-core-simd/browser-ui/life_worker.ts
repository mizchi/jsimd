import {
  ATOMIC_INPUT_KIND,
  ATOMIC_INPUT_RECORD_WORDS,
  AtomicInputBuffer,
} from "../atomic_input.ts";
import { cellFromFixedPoint, countLiveCells, drawLifeLine, stepLife } from "../life_game.ts";
import { type LifeRuntime, WasmSimdLife } from "../life_kernel.ts";
import { LIFE_COMMAND, LifeSharedBoard } from "../life_shared.ts";

interface InitMessage {
  readonly type: "init";
  readonly inputBuffer: SharedArrayBuffer;
  readonly boardBuffer: SharedArrayBuffer;
  readonly runtime: LifeRuntime;
}

self.onmessage = (event: MessageEvent<InitMessage>) => {
  if (event.data.type !== "init") return;
  const input = AtomicInputBuffer.attach(event.data.inputBuffer);
  const board = LifeSharedBoard.attach(event.data.boardBuffer);
  void initialize(input, board, event.data.runtime);
};

async function initialize(
  input: AtomicInputBuffer,
  board: LifeSharedBoard,
  runtime: LifeRuntime,
): Promise<void> {
  const simd = runtime === "simd" ? await WasmSimdLife.create(board.width, board.height) : null;
  let current: Uint8Array = simd?.cells ?? new Uint8Array(board.cellCount);
  let next: Uint8Array | null = simd === null ? new Uint8Array(board.cellCount) : null;
  const latest = new Int32Array(ATOMIC_INPUT_RECORD_WORDS);
  const discrete = new Int32Array(input.capacity * ATOMIC_INPUT_RECORD_WORDS);
  let latestSequence = 0;
  let commandSequence = board.commandSequence;
  let dragging = false;
  let dragValue: 0 | 1 = 1;
  let lastX = 0;
  let lastY = 0;
  let seed = 0x51f1_5e5d;

  const randomize = (): void => {
    for (let index = 0; index < current.length; index++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      current[index] = (seed >>> 0) % 100 < 22 ? 1 : 0;
    }
  };
  const advance = (): number => {
    if (simd !== null) {
      const live = simd.step();
      current = simd.cells;
      return live;
    }
    const live = stepLife(current, next!, board.width, board.height);
    [current, next] = [next!, current];
    return live;
  };
  const publish = (stepMicros = 0, inputTimeMicros?: number): void => {
    const write = board.beginWrite();
    write.cells.set(current);
    board.publish(write.index, countLiveCells(current), stepMicros, inputTimeMicros);
  };
  const point = (records: Int32Array, offset: number) =>
    cellFromFixedPoint(
      records[offset + 2]!,
      records[offset + 3]!,
      board.viewport,
      board.width,
      board.height,
    );

  randomize();
  publish();
  self.postMessage({ type: "ready" });

  // The worker owns this blocking loop. All later control is shared memory + one wake word.
  setTimeout(() => {
    let nextStepAt = performance.now();
    while (true) {
      let changed = false;
      let changedInputTimeMicros: number | undefined;
      const nextCommandSequence = board.commandSequence;
      if (nextCommandSequence !== commandSequence) {
        commandSequence = nextCommandSequence;
        switch (board.command) {
          case LIFE_COMMAND.toggleRunning:
            board.running = !board.running;
            nextStepAt = performance.now();
            break;
          case LIFE_COMMAND.step: {
            board.running = false;
            const started = performance.now();
            const live = advance();
            const write = board.beginWrite();
            write.cells.set(current);
            board.publish(write.index, live, (performance.now() - started) * 1_000);
            break;
          }
          case LIFE_COMMAND.randomize:
            randomize();
            changed = true;
            break;
          case LIFE_COMMAND.clear:
            current.fill(0);
            changed = true;
            break;
        }
      }

      const discreteCount = input.drainInto(discrete);
      for (let record = 0; record < discreteCount; record++) {
        const offset = record * ATOMIC_INPUT_RECORD_WORDS;
        const kind = discrete[offset];
        if (kind === ATOMIC_INPUT_KIND.pointerDown) {
          const cell = point(discrete, offset);
          const flags = discrete[offset + 5]! >>> 0;
          const button = ((flags >>> 16) & 0xff) - 1;
          dragValue = button === 2 || (flags >>> 24 & 1) !== 0 ? 0 : 1;
          dragging = true;
          lastX = cell.x;
          lastY = cell.y;
          current[lastY * board.width + lastX] = dragValue;
          changed = true;
          changedInputTimeMicros = discrete[offset + 6]! >>> 0;
        } else if (kind === ATOMIC_INPUT_KIND.pointerUp) {
          if (dragging) {
            const cell = point(discrete, offset);
            drawLifeLine(
              current,
              board.width,
              board.height,
              lastX,
              lastY,
              cell.x,
              cell.y,
              dragValue,
            );
            changed = true;
            changedInputTimeMicros = discrete[offset + 6]! >>> 0;
          }
          dragging = false;
        } else if (kind === ATOMIC_INPUT_KIND.pointerCancel) {
          dragging = false;
        }
      }

      const nextLatestSequence = input.readLatestInto(latest);
      if (
        dragging && nextLatestSequence !== 0 && nextLatestSequence !== latestSequence &&
        latest[0] === ATOMIC_INPUT_KIND.pointerMove
      ) {
        latestSequence = nextLatestSequence;
        const cell = point(latest, 0);
        drawLifeLine(
          current,
          board.width,
          board.height,
          lastX,
          lastY,
          cell.x,
          cell.y,
          dragValue,
        );
        lastX = cell.x;
        lastY = cell.y;
        changed = true;
        changedInputTimeMicros = latest[6]! >>> 0;
      } else if (nextLatestSequence !== 0) {
        latestSequence = nextLatestSequence;
      }

      if (changed) publish(0, changedInputTimeMicros);

      const now = performance.now();
      const interval = 1_000 / board.rate;
      if (board.running && now >= nextStepAt) {
        const started = performance.now();
        const live = advance();
        const write = board.beginWrite();
        write.cells.set(current);
        board.publish(write.index, live, (performance.now() - started) * 1_000);
        nextStepAt = performance.now() + interval;
      }

      const wakeSequence = input.wakeSequence;
      const timeout = board.running ? Math.max(0, nextStepAt - performance.now()) : undefined;
      input.waitForInput(wakeSequence, timeout);
    }
  }, 0);
}
