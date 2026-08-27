import {
  releaseSharedOwner,
  type SharedOwnershipBuffer,
  tryClaimSharedOwner,
} from "./ownership.ts";

export const STRIPED_ACCUMULATOR_CACHE_LINE_BYTES = 64;

const HISTOGRAM_MAGIC = 0x5354_4847;
const HISTOGRAM_ABI_VERSION = 1;
const HEADER_WORDS = STRIPED_ACCUMULATOR_CACHE_LINE_BYTES / Int32Array.BYTES_PER_ELEMENT;
const OWNERS_BYTE_OFFSET = STRIPED_ACCUMULATOR_CACHE_LINE_BYTES;

const MAGIC_INDEX = 0;
const VERSION_INDEX = 1;
const BUCKET_COUNT_INDEX = 2;
const STRIPE_COUNT_INDEX = 3;
const PADDED_BUCKETS_INDEX = 4;
const STRIPE_STRIDE_INDEX = 5;
const DATA_OFFSET_INDEX = 6;
const RESULT_OFFSET_INDEX = 7;
const BYTE_LENGTH_INDEX = 8;
const REDUCTION_OWNER_INDEX = 9;

export interface StripedHistogramOptions {
  readonly bucketCount: number;
  readonly stripeCount: number;
}

export interface StripedHistogramBuffer extends SharedOwnershipBuffer {
  readonly workerId: number;
  readonly byteLength: number;
  int32Array(byteOffset: number, length: number): Int32Array;
  uint32Array(byteOffset: number, length: number): Uint32Array;
  reduceUint32ShardsSum(
    destinationByteOffset: number,
    sourceByteOffset: number,
    shardCount: number,
    shardStride: number,
    paddedWords: number,
  ): void;
}

export interface StripedHistogramStripe extends Disposable {
  readonly index: number;
  readonly bucketCount: number;
  readonly disposed: boolean;
  valueAt(bucket: number): number;
  increment(bucket: number): void;
  add(bucket: number, amount: number): void;
  setFrom(values: Uint32Array): void;
  clearAll(): void;
}

/** Worker-owned u32 histogram stripes with barrier-delimited wrapping SIMD reduction. */
export class StripedHistogram {
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly dataByteOffset: number;
  readonly resultByteOffset: number;
  readonly bucketCount: number;
  readonly stripeCount: number;
  readonly paddedBuckets: number;
  readonly stripeStride: number;
  readonly #buffer: StripedHistogramBuffer;
  readonly #header: Int32Array;
  readonly #owners: Int32Array;

  private constructor(
    buffer: StripedHistogramBuffer,
    byteOffset: number,
    layout: Layout,
    header: Int32Array,
  ) {
    this.#buffer = buffer;
    this.#header = header;
    this.byteOffset = byteOffset;
    this.byteLength = layout.byteLength;
    this.dataByteOffset = byteOffset + layout.dataOffset;
    this.resultByteOffset = byteOffset + layout.resultOffset;
    this.bucketCount = layout.bucketCount;
    this.stripeCount = layout.stripeCount;
    this.paddedBuckets = layout.paddedBuckets;
    this.stripeStride = layout.stripeStride;
    this.#owners = buffer.int32Array(byteOffset + OWNERS_BYTE_OFFSET, layout.stripeCount);
  }

  static byteLengthFor(options: StripedHistogramOptions): number {
    return validateOptions(options).byteLength;
  }

  static initialize(
    buffer: StripedHistogramBuffer,
    byteOffset: number,
    options: StripedHistogramOptions,
  ): StripedHistogram {
    validateByteOffset(byteOffset);
    const layout = validateOptions(options);
    buffer.uint32Array(byteOffset, layout.byteLength / 4).fill(0);
    const header = buffer.int32Array(byteOffset, HEADER_WORDS);
    Atomics.store(header, VERSION_INDEX, HISTOGRAM_ABI_VERSION);
    Atomics.store(header, BUCKET_COUNT_INDEX, layout.bucketCount);
    Atomics.store(header, STRIPE_COUNT_INDEX, layout.stripeCount);
    Atomics.store(header, PADDED_BUCKETS_INDEX, layout.paddedBuckets);
    Atomics.store(header, STRIPE_STRIDE_INDEX, layout.stripeStride);
    Atomics.store(header, DATA_OFFSET_INDEX, layout.dataOffset);
    Atomics.store(header, RESULT_OFFSET_INDEX, layout.resultOffset);
    Atomics.store(header, BYTE_LENGTH_INDEX, layout.byteLength);
    Atomics.store(header, MAGIC_INDEX, HISTOGRAM_MAGIC);
    return new StripedHistogram(buffer, byteOffset, layout, header);
  }

  static attach(buffer: StripedHistogramBuffer, byteOffset: number): StripedHistogram {
    validateByteOffset(byteOffset);
    const header = buffer.int32Array(byteOffset, HEADER_WORDS);
    if (Atomics.load(header, MAGIC_INDEX) !== HISTOGRAM_MAGIC) {
      throw new RangeError("shared memory does not contain an initialized StripedHistogram");
    }
    const version = Atomics.load(header, VERSION_INDEX);
    if (version !== HISTOGRAM_ABI_VERSION) {
      throw new RangeError(`unsupported StripedHistogram ABI version: ${version}`);
    }
    const layout = validateOptions({
      bucketCount: Atomics.load(header, BUCKET_COUNT_INDEX) >>> 0,
      stripeCount: Atomics.load(header, STRIPE_COUNT_INDEX) >>> 0,
    });
    if (
      (Atomics.load(header, PADDED_BUCKETS_INDEX) >>> 0) !== layout.paddedBuckets ||
      (Atomics.load(header, STRIPE_STRIDE_INDEX) >>> 0) !== layout.stripeStride ||
      (Atomics.load(header, DATA_OFFSET_INDEX) >>> 0) !== layout.dataOffset ||
      (Atomics.load(header, RESULT_OFFSET_INDEX) >>> 0) !== layout.resultOffset ||
      (Atomics.load(header, BYTE_LENGTH_INDEX) >>> 0) !== layout.byteLength
    ) {
      throw new RangeError("invalid StripedHistogram layout");
    }
    buffer.uint32Array(byteOffset, layout.byteLength / 4);
    return new StripedHistogram(buffer, byteOffset, layout, header);
  }

  claimStripe(index: number = this.#buffer.workerId): StripedHistogramStripe {
    this.#assertAlive();
    validateIndex(index, this.stripeCount, "stripe");
    if (!tryClaimSharedOwner(this.#buffer, this.#owners, index)) {
      throw new RangeError("StripedHistogram stripe is already claimed");
    }
    return new HistogramStripeLease(
      this.#buffer,
      this.#owners,
      index,
      this.#buffer.leaseToken,
      this.bucketCount,
      this.#buffer.uint32Array(
        this.dataByteOffset + index * this.stripeStride,
        this.paddedBuckets,
      ),
    );
  }

  reduceInto(output: Uint32Array): number {
    this.#assertAlive();
    if (!(output instanceof Uint32Array)) throw new TypeError("output must be a Uint32Array");
    if (output.length < this.bucketCount) throw new RangeError("output is too small");
    if (!tryClaimSharedOwner(this.#buffer, this.#header, REDUCTION_OWNER_INDEX)) {
      throw new RangeError("StripedHistogram reduction is already running");
    }
    try {
      this.#buffer.reduceUint32ShardsSum(
        this.resultByteOffset,
        this.dataByteOffset,
        this.stripeCount,
        this.stripeStride,
        this.paddedBuckets,
      );
      output.set(
        this.#buffer.uint32Array(this.resultByteOffset, this.paddedBuckets).subarray(
          0,
          this.bucketCount,
        ),
      );
      return this.bucketCount;
    } finally {
      releaseSharedOwner(this.#buffer, this.#header, REDUCTION_OWNER_INDEX);
      Atomics.notify(this.#header, REDUCTION_OWNER_INDEX, 1);
    }
  }

  #assertAlive(): void {
    if (this.#buffer.disposed) throw new Error("SharedBuffer lease has been disposed");
  }
}

class HistogramStripeLease implements StripedHistogramStripe {
  readonly index: number;
  readonly bucketCount: number;
  readonly #buffer: StripedHistogramBuffer;
  readonly #owners: Int32Array;
  readonly #owner: number;
  readonly #buckets: Uint32Array;
  #disposed = false;

  constructor(
    buffer: StripedHistogramBuffer,
    owners: Int32Array,
    index: number,
    owner: number,
    bucketCount: number,
    buckets: Uint32Array,
  ) {
    this.#buffer = buffer;
    this.#owners = owners;
    this.index = index;
    this.#owner = owner;
    this.bucketCount = bucketCount;
    this.#buckets = buckets;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  valueAt(bucket: number): number {
    this.#assertBucket(bucket);
    return this.#buckets[bucket]!;
  }

  increment(bucket: number): void {
    this.add(bucket, 1);
  }

  add(bucket: number, amount: number): void {
    this.#assertBucket(bucket);
    validateUint32(amount, "amount");
    this.#buckets[bucket] = (this.#buckets[bucket]! + amount) >>> 0;
  }

  /** Replaces all logical buckets from one worker-local histogram. */
  setFrom(values: Uint32Array): void {
    this.#assertAlive();
    if (!(values instanceof Uint32Array)) throw new TypeError("values must be a Uint32Array");
    if (values.length < this.bucketCount) throw new RangeError("values is too small");
    this.#buckets.set(values.subarray(0, this.bucketCount));
    this.#buckets.fill(0, this.bucketCount);
  }

  clearAll(): void {
    this.#assertAlive();
    this.#buckets.fill(0);
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    Atomics.compareExchange(this.#owners, this.index, this.#owner, 0);
  }

  #assertBucket(bucket: number): void {
    this.#assertAlive();
    validateIndex(bucket, this.bucketCount, "bucket");
  }

  #assertAlive(): void {
    if (this.#buffer.disposed) throw new Error("SharedBuffer lease has been disposed");
    if (this.#disposed || Atomics.load(this.#owners, this.index) !== this.#owner) {
      throw new Error("StripedHistogram stripe lease has been disposed or lost ownership");
    }
  }
}

export interface StripedCounterStripe extends Disposable {
  readonly index: number;
  readonly value: number;
  readonly disposed: boolean;
  increment(): void;
  add(amount: number): void;
  reset(): void;
}

/** A wrapping u32 counter per Worker, summed only after an external synchronization boundary. */
export class StripedCounter {
  readonly #histogram: StripedHistogram;

  private constructor(histogram: StripedHistogram) {
    this.#histogram = histogram;
  }

  static byteLengthFor(stripeCount: number): number {
    return StripedHistogram.byteLengthFor({ bucketCount: 1, stripeCount });
  }

  static initialize(
    buffer: StripedHistogramBuffer,
    byteOffset: number,
    stripeCount: number,
  ): StripedCounter {
    return new StripedCounter(
      StripedHistogram.initialize(buffer, byteOffset, { bucketCount: 1, stripeCount }),
    );
  }

  static attach(buffer: StripedHistogramBuffer, byteOffset: number): StripedCounter {
    const histogram = StripedHistogram.attach(buffer, byteOffset);
    if (histogram.bucketCount !== 1) {
      throw new RangeError("shared StripedHistogram is not a StripedCounter layout");
    }
    return new StripedCounter(histogram);
  }

  get byteOffset(): number {
    return this.#histogram.byteOffset;
  }

  get byteLength(): number {
    return this.#histogram.byteLength;
  }

  get stripeCount(): number {
    return this.#histogram.stripeCount;
  }

  get stripeStride(): number {
    return this.#histogram.stripeStride;
  }

  claimStripe(index?: number): StripedCounterStripe {
    return new CounterStripeLease(this.#histogram.claimStripe(index));
  }

  sum(): number {
    const output = new Uint32Array(1);
    this.#histogram.reduceInto(output);
    return output[0]!;
  }
}

class CounterStripeLease implements StripedCounterStripe {
  readonly #stripe: StripedHistogramStripe;

  constructor(stripe: StripedHistogramStripe) {
    this.#stripe = stripe;
  }

  get index(): number {
    return this.#stripe.index;
  }

  get value(): number {
    return this.#stripe.valueAt(0);
  }

  get disposed(): boolean {
    return this.#stripe.disposed;
  }

  increment(): void {
    this.#stripe.increment(0);
  }

  add(amount: number): void {
    this.#stripe.add(0, amount);
  }

  reset(): void {
    this.#stripe.clearAll();
  }

  [Symbol.dispose](): void {
    this.#stripe[Symbol.dispose]();
  }
}

interface Layout {
  readonly bucketCount: number;
  readonly stripeCount: number;
  readonly paddedBuckets: number;
  readonly stripeStride: number;
  readonly dataOffset: number;
  readonly resultOffset: number;
  readonly byteLength: number;
}

function validateOptions(options: StripedHistogramOptions): Layout {
  if (options === null || typeof options !== "object") {
    throw new TypeError("options must be an object");
  }
  const { bucketCount, stripeCount } = options;
  if (!Number.isSafeInteger(bucketCount) || bucketCount < 1 || bucketCount > 0xffff_ffff) {
    throw new RangeError("bucketCount must be a positive unsigned 32-bit integer");
  }
  if (!Number.isSafeInteger(stripeCount) || stripeCount < 1 || stripeCount > 0x7fff_ffff) {
    throw new RangeError("stripeCount must be a positive 32-bit integer");
  }
  const paddedBuckets = alignTo(bucketCount, 4);
  const stripeStride = alignTo(
    Math.max(STRIPED_ACCUMULATOR_CACHE_LINE_BYTES, paddedBuckets * 4),
    STRIPED_ACCUMULATOR_CACHE_LINE_BYTES,
  );
  const dataOffset = alignTo(
    OWNERS_BYTE_OFFSET + stripeCount * Int32Array.BYTES_PER_ELEMENT,
    STRIPED_ACCUMULATOR_CACHE_LINE_BYTES,
  );
  const resultOffset = dataOffset + stripeCount * stripeStride;
  const byteLength = resultOffset + stripeStride;
  if (![dataOffset, resultOffset, byteLength].every(Number.isSafeInteger)) {
    throw new RangeError("StripedHistogram layout exceeds the safe integer range");
  }
  return {
    bucketCount,
    stripeCount,
    paddedBuckets,
    stripeStride,
    dataOffset,
    resultOffset,
    byteLength,
  };
}

function validateByteOffset(byteOffset: number): void {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) {
    throw new RangeError("byteOffset must be a non-negative safe integer");
  }
  if (byteOffset % STRIPED_ACCUMULATOR_CACHE_LINE_BYTES !== 0) {
    throw new RangeError(`byteOffset must be ${STRIPED_ACCUMULATOR_CACHE_LINE_BYTES}-byte aligned`);
  }
}

function validateIndex(index: number, length: number, name: string): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= length) {
    throw new RangeError(`${name} index out of bounds`);
  }
}

function validateUint32(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${name} must be an unsigned 32-bit integer`);
  }
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
