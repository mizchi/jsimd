import type { SharedBuffer, VersionedBuffer } from "@mizchi/jsimd-shared";
import type { QueryKernels } from "./kernel.ts";
import type { GroupQueryWorkerInit } from "./group_protocol.ts";
import { AggregateStateBlock } from "./aggregate_state.ts";

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

export interface GroupWorkerResult {
  readonly state: AggregateStateBlock;
  readonly pagesScanned: number;
  readonly pagesSkipped: number;
  readonly cancelled: boolean;
}

export function groupResultSlotBytes(groupCount: number): number {
  return GROUP_RESULT_HEADER_BYTES + AggregateStateBlock.byteLengthFor(groupCount);
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
  const state = AggregateStateBlock.attach(
    shared,
    layout.resultOffset + GROUP_RESULT_HEADER_BYTES,
    layout.groupCount,
  ).reset();

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
      state.countsPointer,
      state.sumsPointer,
      state.minimumsPointer,
      state.maximumsPointer,
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
  return {
    state: AggregateStateBlock.attach(
      shared,
      resultOffset + GROUP_RESULT_HEADER_BYTES,
      groupCount,
    ),
    pagesScanned: header[1]!,
    pagesSkipped: header[2]!,
    cancelled: header[3] !== 0,
  };
}
