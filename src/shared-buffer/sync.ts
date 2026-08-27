export const SHARED_SYNC_BYTE_LENGTH = 64;

const SYNC_WORDS = SHARED_SYNC_BYTE_LENGTH / Int32Array.BYTES_PER_ELEMENT;
const SYNC_ABI_VERSION = 1;
const MAGIC_INDEX = 0;
const VERSION_INDEX = 1;

const MUTEX_MAGIC = 0x4d55_5458;
const MUTEX_STATE_INDEX = 2;
const MUTEX_OWNER_INDEX = 3;

const BARRIER_MAGIC = 0x4241_5252;
const BARRIER_PARTIES_INDEX = 2;
const BARRIER_REMAINING_INDEX = 3;
const BARRIER_GENERATION_INDEX = 4;

const WAIT_GROUP_MAGIC = 0x5747_5250;
const WAIT_GROUP_COUNT_INDEX = 2;
const MAX_SIGNED_COUNT = 0x7fff_ffff;

/** The minimal shared-memory contract required by the synchronization views. */
export interface SharedSyncBuffer {
  readonly workerId: number;
  readonly disposed: boolean;
  int32Array(byteOffset: number, length: number): Int32Array;
}

/** A non-reentrant mutex whose blocking API is intended for Worker threads. */
export class SharedMutex {
  readonly byteOffset: number;
  readonly #buffer: SharedSyncBuffer;
  readonly #state: Int32Array;

  private constructor(buffer: SharedSyncBuffer, byteOffset: number, state: Int32Array) {
    this.#buffer = buffer;
    this.byteOffset = byteOffset;
    this.#state = state;
  }

  /** Initializes an unshared cache line. Call this before publishing the buffer to Workers. */
  static initialize(buffer: SharedSyncBuffer, byteOffset: number): SharedMutex {
    const words = synchronizationWords(buffer, byteOffset);
    words.fill(0);
    Atomics.store(words, VERSION_INDEX, SYNC_ABI_VERSION);
    Atomics.store(words, MAGIC_INDEX, MUTEX_MAGIC);
    return new SharedMutex(buffer, byteOffset, words);
  }

  static attach(buffer: SharedSyncBuffer, byteOffset: number): SharedMutex {
    const words = synchronizationWords(buffer, byteOffset);
    validateLayout(words, MUTEX_MAGIC, "SharedMutex");
    return new SharedMutex(buffer, byteOffset, words);
  }

  get isLocked(): boolean {
    return Atomics.load(this.#words(), MUTEX_STATE_INDEX) !== 0;
  }

  tryLock(): boolean {
    return this.#tryAcquire(this.#words());
  }

  /** Blocks the current Worker. Use lockAsync() on a browser main thread. */
  lock(): void {
    const words = this.#words();
    if (this.#tryAcquire(words)) return;
    this.#throwIfRecursive(words);
    while (true) {
      waitForAtomicChangeBlocking(words, MUTEX_STATE_INDEX, 1, "SharedMutex.lock");
      if (this.#tryAcquire(words)) return;
      this.#throwIfRecursive(words);
    }
  }

  async lockAsync(): Promise<void> {
    const words = this.#words();
    if (this.#tryAcquire(words)) return;
    this.#throwIfRecursive(words);
    while (true) {
      await waitForAtomicChangeAsync(words, MUTEX_STATE_INDEX, 1);
      if (this.#tryAcquire(words)) return;
      this.#throwIfRecursive(words);
    }
  }

  unlock(): void {
    const words = this.#words();
    const owner = this.#buffer.workerId + 1;
    if (Atomics.load(words, MUTEX_OWNER_INDEX) !== owner) {
      throw new Error("SharedMutex can only be unlocked by its owning worker");
    }
    Atomics.store(words, MUTEX_OWNER_INDEX, 0);
    Atomics.store(words, MUTEX_STATE_INDEX, 0);
    Atomics.notify(words, MUTEX_STATE_INDEX, 1);
  }

  #words(): Int32Array {
    assertBufferAlive(this.#buffer);
    return this.#state;
  }

  #tryAcquire(words: Int32Array): boolean {
    if (Atomics.compareExchange(words, MUTEX_STATE_INDEX, 0, 1) !== 0) return false;
    Atomics.store(words, MUTEX_OWNER_INDEX, this.#buffer.workerId + 1);
    return true;
  }

  #throwIfRecursive(words: Int32Array): void {
    if (Atomics.load(words, MUTEX_OWNER_INDEX) === this.#buffer.workerId + 1) {
      throw new Error("SharedMutex is not reentrant");
    }
  }
}

/** A reusable fixed-party barrier. Every party must arrive exactly once per generation. */
export class SharedBarrier {
  readonly byteOffset: number;
  readonly parties: number;
  readonly #buffer: SharedSyncBuffer;
  readonly #state: Int32Array;

  private constructor(
    buffer: SharedSyncBuffer,
    byteOffset: number,
    parties: number,
    state: Int32Array,
  ) {
    this.#buffer = buffer;
    this.byteOffset = byteOffset;
    this.parties = parties;
    this.#state = state;
  }

  /** Initializes an unshared cache line. Call this before publishing the buffer to Workers. */
  static initialize(
    buffer: SharedSyncBuffer,
    byteOffset: number,
    parties: number,
  ): SharedBarrier {
    validatePositiveCount(parties, "parties");
    const words = synchronizationWords(buffer, byteOffset);
    words.fill(0);
    Atomics.store(words, VERSION_INDEX, SYNC_ABI_VERSION);
    Atomics.store(words, BARRIER_PARTIES_INDEX, parties);
    Atomics.store(words, BARRIER_REMAINING_INDEX, parties);
    Atomics.store(words, MAGIC_INDEX, BARRIER_MAGIC);
    return new SharedBarrier(buffer, byteOffset, parties, words);
  }

  static attach(buffer: SharedSyncBuffer, byteOffset: number): SharedBarrier {
    const words = synchronizationWords(buffer, byteOffset);
    validateLayout(words, BARRIER_MAGIC, "SharedBarrier");
    const parties = Atomics.load(words, BARRIER_PARTIES_INDEX);
    validatePositiveCount(parties, "stored parties");
    return new SharedBarrier(buffer, byteOffset, parties, words);
  }

  /** Blocks the current Worker until all parties arrive. */
  arriveAndWait(): void {
    const words = this.#words();
    const generation = Atomics.load(words, BARRIER_GENERATION_INDEX);
    if (this.#arrive(words)) return;
    while (Atomics.load(words, BARRIER_GENERATION_INDEX) === generation) {
      waitForAtomicChangeBlocking(
        words,
        BARRIER_GENERATION_INDEX,
        generation,
        "SharedBarrier.arriveAndWait",
      );
    }
  }

  async arriveAndWaitAsync(): Promise<void> {
    const words = this.#words();
    const generation = Atomics.load(words, BARRIER_GENERATION_INDEX);
    if (this.#arrive(words)) return;
    while (Atomics.load(words, BARRIER_GENERATION_INDEX) === generation) {
      await waitForAtomicChangeAsync(words, BARRIER_GENERATION_INDEX, generation);
    }
  }

  #arrive(words: Int32Array): boolean {
    while (true) {
      const remaining = Atomics.load(words, BARRIER_REMAINING_INDEX);
      if (remaining <= 0) throw new Error("too many parties arrived at SharedBarrier");
      if (
        Atomics.compareExchange(
          words,
          BARRIER_REMAINING_INDEX,
          remaining,
          remaining - 1,
        ) !== remaining
      ) continue;
      if (remaining !== 1) return false;
      Atomics.store(words, BARRIER_REMAINING_INDEX, this.parties);
      Atomics.add(words, BARRIER_GENERATION_INDEX, 1);
      Atomics.notify(words, BARRIER_GENERATION_INDEX);
      return true;
    }
  }

  #words(): Int32Array {
    assertBufferAlive(this.#buffer);
    return this.#state;
  }
}

/** A shared non-negative task counter with Worker-blocking and main-thread async waits. */
export class SharedWaitGroup {
  readonly byteOffset: number;
  readonly #buffer: SharedSyncBuffer;
  readonly #state: Int32Array;

  private constructor(buffer: SharedSyncBuffer, byteOffset: number, state: Int32Array) {
    this.#buffer = buffer;
    this.byteOffset = byteOffset;
    this.#state = state;
  }

  /** Initializes an unshared cache line. Call this before publishing the buffer to Workers. */
  static initialize(
    buffer: SharedSyncBuffer,
    byteOffset: number,
    initialCount = 0,
  ): SharedWaitGroup {
    validateCount(initialCount, "initialCount");
    const words = synchronizationWords(buffer, byteOffset);
    words.fill(0);
    Atomics.store(words, VERSION_INDEX, SYNC_ABI_VERSION);
    Atomics.store(words, WAIT_GROUP_COUNT_INDEX, initialCount);
    Atomics.store(words, MAGIC_INDEX, WAIT_GROUP_MAGIC);
    return new SharedWaitGroup(buffer, byteOffset, words);
  }

  static attach(buffer: SharedSyncBuffer, byteOffset: number): SharedWaitGroup {
    const words = synchronizationWords(buffer, byteOffset);
    validateLayout(words, WAIT_GROUP_MAGIC, "SharedWaitGroup");
    validateCount(Atomics.load(words, WAIT_GROUP_COUNT_INDEX), "stored count");
    return new SharedWaitGroup(buffer, byteOffset, words);
  }

  get count(): number {
    return Atomics.load(this.#words(), WAIT_GROUP_COUNT_INDEX);
  }

  add(delta: number): void {
    if (!Number.isSafeInteger(delta)) throw new RangeError("delta must be a safe integer");
    const words = this.#words();
    while (true) {
      const current = Atomics.load(words, WAIT_GROUP_COUNT_INDEX);
      const next = current + delta;
      validateCount(next, "wait group count");
      if (Atomics.compareExchange(words, WAIT_GROUP_COUNT_INDEX, current, next) !== current) {
        continue;
      }
      if (next === 0) Atomics.notify(words, WAIT_GROUP_COUNT_INDEX);
      return;
    }
  }

  done(): void {
    this.add(-1);
  }

  /** Blocks the current Worker until the count reaches zero. */
  wait(): void {
    const words = this.#words();
    while (true) {
      const count = Atomics.load(words, WAIT_GROUP_COUNT_INDEX);
      if (count === 0) return;
      waitForAtomicChangeBlocking(words, WAIT_GROUP_COUNT_INDEX, count, "SharedWaitGroup.wait");
    }
  }

  async waitAsync(): Promise<void> {
    const words = this.#words();
    while (true) {
      const count = Atomics.load(words, WAIT_GROUP_COUNT_INDEX);
      if (count === 0) return;
      await waitForAtomicChangeAsync(words, WAIT_GROUP_COUNT_INDEX, count);
    }
  }

  #words(): Int32Array {
    assertBufferAlive(this.#buffer);
    return this.#state;
  }
}

function assertBufferAlive(buffer: SharedSyncBuffer): void {
  if (buffer.disposed) throw new Error("SharedBuffer lease has been disposed");
}

function synchronizationWords(buffer: SharedSyncBuffer, byteOffset: number): Int32Array {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) {
    throw new RangeError("byteOffset must be a non-negative safe integer");
  }
  if (byteOffset % SHARED_SYNC_BYTE_LENGTH !== 0) {
    throw new RangeError(`byteOffset must be ${SHARED_SYNC_BYTE_LENGTH}-byte aligned`);
  }
  return buffer.int32Array(byteOffset, SYNC_WORDS);
}

function validateLayout(words: Int32Array, magic: number, name: string): void {
  if (Atomics.load(words, MAGIC_INDEX) !== magic) {
    throw new RangeError(`shared memory does not contain an initialized ${name}`);
  }
  const version = Atomics.load(words, VERSION_INDEX);
  if (version !== SYNC_ABI_VERSION) {
    throw new RangeError(`unsupported ${name} ABI version: ${version}`);
  }
}

function validatePositiveCount(value: number, name: string): void {
  validateCount(value, name);
  if (value === 0) throw new RangeError(`${name} must be positive`);
}

function validateCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SIGNED_COUNT) {
    throw new RangeError(`${name} must be between 0 and ${MAX_SIGNED_COUNT}`);
  }
}

/** @internal Shared wait primitive used by structures in this entrypoint. */
export function waitForAtomicChangeBlocking(
  words: Int32Array,
  index: number,
  value: number,
  operation: string,
): void {
  try {
    Atomics.wait(words, index, value);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new TypeError(`${operation} cannot block this thread; use the async method instead`);
    }
    throw error;
  }
}

/** @internal Shared wait primitive used by structures in this entrypoint. */
export async function waitForAtomicChangeAsync(
  words: Int32Array,
  index: number,
  value: number,
): Promise<void> {
  const result = Atomics.waitAsync(words, index, value);
  if (!result.async) return;

  // Deno 2.6 / V8 reports a notified waiter for growable WebAssembly shared memory but does not
  // resolve its waitAsync promise. Polling is only a compatibility fallback; conforming runtimes
  // resolve through waitAsync first. The interval also keeps a top-level Deno await alive.
  let poll: ReturnType<typeof setInterval> | undefined;
  const fallback = new Promise<void>((resolve) => {
    poll = setInterval(() => {
      if (Atomics.load(words, index) !== value) resolve();
    }, 1);
  });
  try {
    await Promise.race([result.value, fallback]);
  } finally {
    clearInterval(poll);
  }
}
