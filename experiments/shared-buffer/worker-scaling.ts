import { SharedBuffer, StripedHistogram } from "../../packages/jsimd/src/shared-buffer/mod.ts";

const WORKER_COUNTS = [1, 2, 4, 8] as const;
const BUCKET_COUNT = 4_096;
const TOTAL_EVENTS = 1 << 23;
const COUNTER_ITERATIONS = 500_000;
const WARMUPS = 1;
const SAMPLES = 7;

type Mode = "postMessage" | "atomics" | "striped";
interface WorkerResult {
  readonly histogram?: Uint32Array;
  readonly checksum: number;
  readonly elapsedMs: number;
}

interface Measurement {
  readonly mode: string;
  readonly workers: number;
  readonly throughputMops: number;
  readonly medianMs: number;
  readonly p99Ms: number;
  readonly workerTailP99Ms: number;
}

const moduleUrl = new URL("../../packages/jsimd/src/shared-buffer/mod.ts", import.meta.url).href;
const workerUrl = URL.createObjectURL(
  new Blob([
    `import { SharedBuffer, StripedHistogram } from ${JSON.stringify(moduleUrl)};
let shared;
self.onmessage = async (event) => {
  const data = event.data;
  if (data.kind === "init") {
    shared = await SharedBuffer.attach(data.memory);
    self.postMessage({ kind: "ready", lease: shared.workerLease });
    return;
  }
  if (data.kind === "stop") {
    shared?.[Symbol.dispose]();
    self.postMessage({ kind: "stopped", checksum: 0, elapsedMs: 0 });
    self.close();
    return;
  }
  if (data.kind === "counter") {
    const words = new Int32Array(data.buffer);
    const started = performance.now();
    for (let index = 0; index < data.iterations; index++) Atomics.add(words, data.index, 1);
    self.postMessage({ checksum: Atomics.load(words, data.index) >>> 0, elapsedMs: performance.now() - started });
    return;
  }
  const started = performance.now();
  let state = data.seed >>> 0;
  let checksum = 0;
  if (data.mode === "postMessage") {
    const histogram = new Uint32Array(data.bucketCount);
    for (let index = 0; index < data.count; index++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const bucket = (state & 3) === 0 ? ((state >>> 8) & (data.bucketCount - 1)) : 0;
      histogram[bucket]++;
      checksum++;
    }
    self.postMessage({ histogram, checksum, elapsedMs: performance.now() - started }, [histogram.buffer]);
    return;
  }
  if (data.mode === "atomics") {
    const histogram = new Uint32Array(data.buffer);
    for (let index = 0; index < data.count; index++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const bucket = (state & 3) === 0 ? ((state >>> 8) & (data.bucketCount - 1)) : 0;
      Atomics.add(histogram, bucket, 1);
      checksum++;
    }
  } else {
    const histogram = StripedHistogram.attach(shared, data.byteOffset);
    using stripe = histogram.claimStripe(data.workerIndex);
    const local = new Uint32Array(data.bucketCount);
    for (let index = 0; index < data.count; index++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const bucket = (state & 3) === 0 ? ((state >>> 8) & (data.bucketCount - 1)) : 0;
      local[bucket]++;
      checksum++;
    }
    stripe.setFrom(local);
  }
  self.postMessage({ checksum, elapsedMs: performance.now() - started });
};`,
  ], { type: "text/javascript" }),
);

try {
  const measurements: Measurement[] = [];
  for (const workerCount of WORKER_COUNTS) {
    measurements.push(...await measureWorkerCount(workerCount));
  }
  measurements.push(await measureSingleThread());
  const falseSharing = [];
  for (const workerCount of WORKER_COUNTS) {
    falseSharing.push(await measureFalseSharing(workerCount));
  }
  console.log(JSON.stringify(
    {
      runtime: { ...Deno.version, ...Deno.build, logicalCpus: navigator.hardwareConcurrency },
      totalEvents: TOTAL_EVENTS,
      bucketCount: BUCKET_COUNT,
      hotBucketProbability: 0.75,
      samples: SAMPLES,
      measurements,
      falseSharing,
    },
    null,
    2,
  ));
} finally {
  URL.revokeObjectURL(workerUrl);
}

async function measureWorkerCount(workerCount: number): Promise<Measurement[]> {
  using shared = await SharedBuffer.create({ initialPages: 3, maximumPages: 3, maxWorkers: 9 });
  const histogram = StripedHistogram.initialize(shared, 0, {
    bucketCount: BUCKET_COUNT,
    stripeCount: 8,
  });
  const workers = Array.from(
    { length: workerCount },
    () => new Worker(workerUrl, { type: "module" }),
  );
  try {
    await Promise.all(
      workers.map((worker) => request(worker, { kind: "init", memory: shared.memory })),
    );
    const results = [];
    for (const mode of ["postMessage", "atomics", "striped"] as const) {
      const durations: number[] = [];
      const tails: number[] = [];
      for (let sample = -WARMUPS; sample < SAMPLES; sample++) {
        const atomicsBuffer = mode === "atomics"
          ? new SharedArrayBuffer(BUCKET_COUNT * Uint32Array.BYTES_PER_ELEMENT)
          : undefined;
        const counts = splitCount(TOTAL_EVENTS, workerCount);
        const started = performance.now();
        const arrivals: number[] = [];
        const replies = await Promise.all(workers.map((worker, workerIndex) =>
          request(worker, {
            kind: "run",
            mode,
            count: counts[workerIndex],
            seed: 0x9e37_79b9 ^ workerIndex,
            bucketCount: BUCKET_COUNT,
            buffer: atomicsBuffer,
            byteOffset: histogram.byteOffset,
            workerIndex,
          }).then((result) => {
            arrivals.push(performance.now() - started);
            return result;
          })
        ));
        const elapsed = performance.now() - started;
        validateRun(mode, replies, histogram, atomicsBuffer);
        if (sample >= 0) {
          durations.push(elapsed);
          tails.push(percentile(arrivals, 0.99));
        }
      }
      results.push(summarize(mode, workerCount, TOTAL_EVENTS, durations, tails));
    }
    return results;
  } finally {
    await Promise.allSettled(workers.map((worker) => request(worker, { kind: "stop" })));
    for (const worker of workers) worker.terminate();
  }
}

async function measureSingleThread(): Promise<Measurement> {
  using shared = await SharedBuffer.create({ initialPages: 1, maximumPages: 1, maxWorkers: 1 });
  const histogram = StripedHistogram.initialize(shared, 0, {
    bucketCount: BUCKET_COUNT,
    stripeCount: 1,
  });
  const durations: number[] = [];
  for (let sample = -WARMUPS; sample < SAMPLES; sample++) {
    const started = performance.now();
    using stripe = histogram.claimStripe(0);
    const local = new Uint32Array(BUCKET_COUNT);
    let state = 0x9e37_79b9;
    for (let index = 0; index < TOTAL_EVENTS; index++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      local[(state & 3) === 0 ? ((state >>> 8) & (BUCKET_COUNT - 1)) : 0]++;
    }
    stripe.setFrom(local);
    const output = new Uint32Array(BUCKET_COUNT);
    histogram.reduceInto(output);
    if (sum(output) !== TOTAL_EVENTS) throw new Error("single-thread checksum mismatch");
    if (sample >= 0) durations.push(performance.now() - started);
  }
  return summarize("single-thread-striped-simd", 1, TOTAL_EVENTS, durations, durations);
}

async function measureFalseSharing(workerCount: number) {
  const workers = Array.from(
    { length: workerCount },
    () => new Worker(workerUrl, { type: "module" }),
  );
  try {
    const result: Record<string, number> = {};
    for (const [name, stride] of [["packed", 1], ["padded", 16]] as const) {
      const durations: number[] = [];
      for (let sample = -WARMUPS; sample < SAMPLES; sample++) {
        const buffer = new SharedArrayBuffer(workerCount * stride * Int32Array.BYTES_PER_ELEMENT);
        const started = performance.now();
        await Promise.all(workers.map((worker, index) =>
          request(worker, {
            kind: "counter",
            buffer,
            index: index * stride,
            iterations: COUNTER_ITERATIONS,
          })
        ));
        const elapsed = performance.now() - started;
        if (sample >= 0) durations.push(elapsed);
      }
      result[`${name}Mops`] = workerCount * COUNTER_ITERATIONS / median(durations) / 1_000;
    }
    return {
      workers: workerCount,
      packedMops: round(result.packedMops!),
      paddedMops: round(result.paddedMops!),
      paddedSpeedup: round(result.paddedMops! / result.packedMops!),
    };
  } finally {
    for (const worker of workers) worker.terminate();
  }
}

function request(worker: Worker, message: unknown): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (event) => resolve(event.data);
    worker.onerror = (event) => reject(event.error ?? new Error(event.message));
    worker.postMessage(message);
  });
}

function validateRun(
  mode: Mode,
  replies: readonly WorkerResult[],
  histogram: StripedHistogram,
  atomicsBuffer: SharedArrayBuffer | undefined,
): void {
  if (sum(Uint32Array.from(replies, (reply) => reply.checksum)) !== TOTAL_EVENTS) {
    throw new Error(`${mode} worker checksum mismatch`);
  }
  if (mode === "postMessage") {
    const merged = new Uint32Array(BUCKET_COUNT);
    for (const reply of replies) {
      if (reply.histogram === undefined) throw new Error("missing postMessage histogram");
      for (let index = 0; index < merged.length; index++) merged[index] += reply.histogram[index]!;
    }
    if (sum(merged) !== TOTAL_EVENTS) throw new Error("postMessage reduction mismatch");
  } else if (mode === "atomics") {
    if (atomicsBuffer === undefined || sum(new Uint32Array(atomicsBuffer)) !== TOTAL_EVENTS) {
      throw new Error("atomic histogram mismatch");
    }
  } else {
    const output = new Uint32Array(BUCKET_COUNT);
    histogram.reduceInto(output);
    if (sum(output) !== TOTAL_EVENTS) throw new Error("striped reduction mismatch");
  }
}

function splitCount(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  return Array.from({ length: parts }, (_, index) => base + (index < total % parts ? 1 : 0));
}

function summarize(
  mode: string,
  workers: number,
  operations: number,
  durations: number[],
  tails: number[],
): Measurement {
  const medianMs = median(durations);
  return {
    mode,
    workers,
    throughputMops: round(operations / medianMs / 1_000),
    medianMs: round(medianMs),
    p99Ms: round(percentile(durations, 0.99)),
    workerTailP99Ms: round(percentile(tails, 0.99)),
  };
}

function sum(values: Uint32Array): number {
  let result = 0;
  for (const value of values) result += value;
  return result;
}

function median(values: readonly number[]): number {
  return percentile(values, 0.5);
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]!;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
