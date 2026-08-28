import type { SharedBuffer, VersionedBuffer } from "@mizchi/jsimd-shared";
import type { QueryKernels } from "./kernel.ts";
import type { QueryWorkerInit } from "./protocol.ts";

export const PAGE_DESCRIPTOR_WORDS = 8;
export const RESULT_SLOT_BYTES = 64;
export const RESULT_SCRATCH_OFFSET = 32;
export const QUERY_WORDS = 6;

export const QUERY_EPOCH_INDEX = 0;
export const QUERY_MINIMUM_INDEX = 1;
export const QUERY_MAXIMUM_INDEX = 2;
export const QUERY_NEXT_PAGE_INDEX = 3;
export const QUERY_CANCEL_EPOCH_INDEX = 4;
export const QUERY_GENERATION_INDEX = 5;

const PAGE_DATA_OFFSET_INDEX = 0;
const PAGE_ROW_COUNT_INDEX = 2;
const PAGE_MINIMUM_INDEX = 3;
const PAGE_MAXIMUM_INDEX = 4;
const PAGE_ENCODING_INDEX = 5;
const PAGE_BIT_WIDTH_INDEX = 6;

export interface ScanWorkerResult {
  readonly epoch: number;
  readonly count: number;
  readonly sum: bigint;
  readonly pagesScanned: number;
  readonly pagesSkipped: number;
  readonly cancelled: boolean;
}

export function scanAvailablePages(
  shared: SharedBuffer,
  kernels: QueryKernels,
  snapshots: VersionedBuffer,
  layout: QueryWorkerInit,
  epoch: number,
): void {
  const query = shared.int32Array(layout.queryOffset, QUERY_WORDS);
  if ((Atomics.load(query, QUERY_EPOCH_INDEX) >>> 0) !== epoch) {
    throw new Error("query task epoch does not match the published query");
  }
  const minimum = Atomics.load(query, QUERY_MINIMUM_INDEX);
  const maximum = Atomics.load(query, QUERY_MAXIMUM_INDEX);
  const expectedGeneration = Atomics.load(query, QUERY_GENERATION_INDEX) >>> 0;
  using snapshot = snapshots.acquire();
  if (snapshot.generation !== expectedGeneration) {
    throw new Error("query snapshot generation is no longer available");
  }
  const descriptors = new Int32Array(
    snapshot.bytes.buffer,
    snapshot.bytes.byteOffset + layout.snapshotDescriptorOffset,
    layout.pageCount * PAGE_DESCRIPTOR_WORDS,
  );
  const scratchPointer = shared.dataOffset + layout.resultOffset + RESULT_SCRATCH_OFFSET;
  const scratch32 = shared.uint32Array(layout.resultOffset + RESULT_SCRATCH_OFFSET, 1);
  const scratch64 = new BigInt64Array(
    shared.memory.buffer,
    scratchPointer + 8,
    1,
  );
  let count = 0;
  let sum = 0n;
  let pagesScanned = 0;
  let pagesSkipped = 0;
  let cancelled = false;

  while (true) {
    if ((Atomics.load(query, QUERY_CANCEL_EPOCH_INDEX) >>> 0) === epoch) {
      cancelled = true;
      break;
    }
    const page = Atomics.add(query, QUERY_NEXT_PAGE_INDEX, 1) >>> 0;
    if (page >= layout.pageCount) break;
    const base = page * PAGE_DESCRIPTOR_WORDS;
    const pageMinimum = descriptors[base + PAGE_MINIMUM_INDEX]!;
    const pageMaximum = descriptors[base + PAGE_MAXIMUM_INDEX]!;
    if (minimum >= maximum || maximum <= pageMinimum || minimum > pageMaximum) {
      pagesSkipped++;
      continue;
    }
    const dataOffset = descriptors[base + PAGE_DATA_OFFSET_INDEX]! >>> 0;
    const rowCount = descriptors[base + PAGE_ROW_COUNT_INDEX]! >>> 0;
    const encoding = descriptors[base + PAGE_ENCODING_INDEX]! >>> 0;
    const bitWidth = descriptors[base + PAGE_BIT_WIDTH_INDEX]! >>> 0;
    const pointer = snapshot.bytes.byteOffset + dataOffset;
    if (encoding === 0) {
      kernels.scan_i32_between_aggregate(pointer, rowCount, minimum, maximum, scratchPointer);
    } else if (encoding === 1) {
      kernels.aggregate_i32_constant(rowCount, pageMinimum, minimum, maximum, scratchPointer);
    } else {
      kernels.scan_adaptive_i32_between_aggregate(
        pointer,
        rowCount,
        encoding,
        bitWidth,
        pageMinimum,
        minimum,
        maximum,
        scratchPointer,
      );
    }
    count += scratch32[0]!;
    sum += scratch64[0]!;
    pagesScanned++;
  }

  const result32 = shared.uint32Array(layout.resultOffset, 5);
  const result64 = new BigInt64Array(
    shared.memory.buffer,
    shared.dataOffset + layout.resultOffset + 16,
    1,
  );
  result32[1] = count;
  result32[2] = pagesScanned;
  result32[3] = pagesSkipped;
  result32[4] = cancelled ? 1 : 0;
  result64[0] = sum;
  Atomics.store(result32, 0, epoch);
}

export function readWorkerResult(
  shared: SharedBuffer,
  resultOffset: number,
  epoch: number,
): ScanWorkerResult {
  const result32 = shared.uint32Array(resultOffset, 5);
  const actualEpoch = Atomics.load(result32, 0) >>> 0;
  if (actualEpoch !== epoch) throw new Error("worker result epoch does not match the query");
  const result64 = new BigInt64Array(
    shared.memory.buffer,
    shared.dataOffset + resultOffset + 16,
    1,
  );
  return {
    epoch,
    count: result32[1]!,
    sum: result64[0]!,
    pagesScanned: result32[2]!,
    pagesSkipped: result32[3]!,
    cancelled: result32[4] !== 0,
  };
}
