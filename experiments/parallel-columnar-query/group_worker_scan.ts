import type { SharedBuffer, VersionedBuffer } from "../../src/shared-buffer/mod.ts";
import type { QueryKernels } from "./kernel.ts";
import type { GroupQueryWorkerInit } from "./group_protocol.ts";

export const GROUP_PAGE_DESCRIPTOR_WORDS = 8;
export const GROUP_RESULT_HEADER_BYTES = 64;
export const GROUP_QUERY_WORDS = 6;

export const GROUP_QUERY_EPOCH_INDEX = 0;
export const GROUP_QUERY_MINIMUM_INDEX = 1;
export const GROUP_QUERY_MAXIMUM_INDEX = 2;
export const GROUP_QUERY_NEXT_PAGE_INDEX = 3;
export const GROUP_QUERY_CANCEL_EPOCH_INDEX = 4;
export const GROUP_QUERY_GENERATION_INDEX = 5;

const PAGE_FILTER_OFFSET_INDEX = 0;
const PAGE_VALUES_OFFSET_INDEX = 1;
const PAGE_GROUPS_OFFSET_INDEX = 2;
const PAGE_ROW_COUNT_INDEX = 4;
const PAGE_MINIMUM_INDEX = 5;
const PAGE_MAXIMUM_INDEX = 6;
const I32_MIN = -0x8000_0000;
const I32_MAX = 0x7fff_ffff;

export interface GroupWorkerResult {
  readonly counts: Uint32Array;
  readonly sums: BigInt64Array;
  readonly minimums: Int32Array;
  readonly maximums: Int32Array;
  readonly pagesScanned: number;
  readonly pagesSkipped: number;
  readonly cancelled: boolean;
}

interface ResultOffsets {
  readonly counts: number;
  readonly sums: number;
  readonly minimums: number;
  readonly maximums: number;
  readonly byteLength: number;
}

export function groupResultSlotBytes(groupCount: number): number {
  return resultOffsets(groupCount).byteLength;
}

export function scanAvailableGroupPages(
  shared: SharedBuffer,
  kernels: QueryKernels,
  snapshots: VersionedBuffer,
  layout: GroupQueryWorkerInit,
  epoch: number,
): void {
  const query = shared.int32Array(layout.queryOffset, GROUP_QUERY_WORDS);
  if ((Atomics.load(query, GROUP_QUERY_EPOCH_INDEX) >>> 0) !== epoch) {
    throw new Error("group query task epoch does not match the published query");
  }
  const minimum = Atomics.load(query, GROUP_QUERY_MINIMUM_INDEX);
  const maximum = Atomics.load(query, GROUP_QUERY_MAXIMUM_INDEX);
  const expectedGeneration = Atomics.load(query, GROUP_QUERY_GENERATION_INDEX) >>> 0;
  using snapshot = snapshots.acquire();
  if (snapshot.generation !== expectedGeneration) {
    throw new Error("group query snapshot generation is no longer available");
  }
  const descriptors = new Int32Array(
    snapshot.bytes.buffer,
    snapshot.bytes.byteOffset + layout.snapshotDescriptorOffset,
    layout.pageCount * GROUP_PAGE_DESCRIPTOR_WORDS,
  );
  const offsets = resultOffsets(layout.groupCount);
  const counts = shared.uint32Array(layout.resultOffset + offsets.counts, layout.groupCount);
  const sums = new BigInt64Array(
    shared.memory.buffer,
    shared.dataOffset + layout.resultOffset + offsets.sums,
    layout.groupCount,
  );
  const minimums = shared.int32Array(layout.resultOffset + offsets.minimums, layout.groupCount);
  const maximums = shared.int32Array(layout.resultOffset + offsets.maximums, layout.groupCount);
  counts.fill(0);
  sums.fill(0n);
  minimums.fill(I32_MAX);
  maximums.fill(I32_MIN);

  let pagesScanned = 0;
  let pagesSkipped = 0;
  let cancelled = false;
  while (true) {
    if ((Atomics.load(query, GROUP_QUERY_CANCEL_EPOCH_INDEX) >>> 0) === epoch) {
      cancelled = true;
      break;
    }
    const page = Atomics.add(query, GROUP_QUERY_NEXT_PAGE_INDEX, 1) >>> 0;
    if (page >= layout.pageCount) break;
    const base = page * GROUP_PAGE_DESCRIPTOR_WORDS;
    const pageMinimum = descriptors[base + PAGE_MINIMUM_INDEX]!;
    const pageMaximum = descriptors[base + PAGE_MAXIMUM_INDEX]!;
    if (minimum >= maximum || maximum <= pageMinimum || minimum > pageMaximum) {
      pagesSkipped++;
      continue;
    }
    const filterOffset = descriptors[base + PAGE_FILTER_OFFSET_INDEX]! >>> 0;
    const valuesOffset = descriptors[base + PAGE_VALUES_OFFSET_INDEX]! >>> 0;
    const groupsOffset = descriptors[base + PAGE_GROUPS_OFFSET_INDEX]! >>> 0;
    const rowCount = descriptors[base + PAGE_ROW_COUNT_INDEX]! >>> 0;
    kernels.scan_i32_between_group_by_u8(
      snapshot.bytes.byteOffset + filterOffset,
      snapshot.bytes.byteOffset + valuesOffset,
      snapshot.bytes.byteOffset + groupsOffset,
      rowCount,
      minimum,
      maximum,
      shared.dataOffset + layout.resultOffset + offsets.counts,
      shared.dataOffset + layout.resultOffset + offsets.sums,
      shared.dataOffset + layout.resultOffset + offsets.minimums,
      shared.dataOffset + layout.resultOffset + offsets.maximums,
    );
    pagesScanned++;
  }

  const header = shared.uint32Array(layout.resultOffset, 4);
  header[1] = pagesScanned;
  header[2] = pagesSkipped;
  header[3] = cancelled ? 1 : 0;
  Atomics.store(header, 0, epoch);
}

export function readGroupWorkerResult(
  shared: SharedBuffer,
  resultOffset: number,
  groupCount: number,
  epoch: number,
): GroupWorkerResult {
  const header = shared.uint32Array(resultOffset, 4);
  if ((Atomics.load(header, 0) >>> 0) !== epoch) {
    throw new Error("group worker result epoch does not match the query");
  }
  const offsets = resultOffsets(groupCount);
  return {
    counts: shared.uint32Array(resultOffset + offsets.counts, groupCount),
    sums: new BigInt64Array(
      shared.memory.buffer,
      shared.dataOffset + resultOffset + offsets.sums,
      groupCount,
    ),
    minimums: shared.int32Array(resultOffset + offsets.minimums, groupCount),
    maximums: shared.int32Array(resultOffset + offsets.maximums, groupCount),
    pagesScanned: header[1]!,
    pagesSkipped: header[2]!,
    cancelled: header[3] !== 0,
  };
}

function resultOffsets(groupCount: number): ResultOffsets {
  const counts = GROUP_RESULT_HEADER_BYTES;
  const sums = alignTo(counts + groupCount * 4, 8);
  const minimums = sums + groupCount * 8;
  const maximums = minimums + groupCount * 4;
  return {
    counts,
    sums,
    minimums,
    maximums,
    byteLength: alignTo(maximums + groupCount * 4, 64),
  };
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
