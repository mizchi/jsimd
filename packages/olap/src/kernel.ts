import { instantiateSharedModule } from "@mizchi/jsimd-shared";

export interface QueryKernels extends WebAssembly.Exports {
  hash_join_build_u32(
    inputKeysPointer: number,
    inputRowsPointer: number,
    length: number,
    partitionSizesPointer: number,
    controlsPointer: number,
    keysPointer: number,
    headsPointer: number,
    nodeRowsPointer: number,
    nodeNextPointer: number,
    bloomPointer: number,
    bloomBlocksPerPartition: number,
    buildRowsPointer: number,
    distinctKeysPointer: number,
    partitionCount: number,
    capacityPerPartition: number,
    maxSizePerPartition: number,
    maxBuildRows: number,
  ): number;
  hash_join_count_u32(
    probeKeysPointer: number,
    length: number,
    controlsPointer: number,
    keysPointer: number,
    headsPointer: number,
    nodeNextPointer: number,
    bloomPointer: number,
    bloomBlocksPerPartition: number,
    partitionCount: number,
    capacityPerPartition: number,
  ): bigint;
  hash_join_probe_u32(
    probeKeysPointer: number,
    probeRowsPointer: number,
    length: number,
    outputProbeRowsPointer: number,
    outputBuildRowsPointer: number,
    outputCapacity: number,
    controlsPointer: number,
    keysPointer: number,
    headsPointer: number,
    nodeRowsPointer: number,
    nodeNextPointer: number,
    bloomPointer: number,
    bloomBlocksPerPartition: number,
    partitionCount: number,
    capacityPerPartition: number,
  ): bigint;
  local_group_find(
    controlsPointer: number,
    keysPointer: number,
    capacity: number,
    key: number,
  ): number;
  local_group_update_i32(
    controlsPointer: number,
    keysPointer: number,
    countsPointer: number,
    nullCountsPointer: number,
    sumsPointer: number,
    minimumsPointer: number,
    maximumsPointer: number,
    sizePointer: number,
    capacity: number,
    maxSize: number,
    key: number,
    value: number,
    valid: number,
  ): number;
  local_group_aggregate_i32(
    inputKeysPointer: number,
    inputValuesPointer: number,
    inputValiditiesPointer: number,
    hasValidities: number,
    length: number,
    controlsPointer: number,
    keysPointer: number,
    countsPointer: number,
    nullCountsPointer: number,
    sumsPointer: number,
    minimumsPointer: number,
    maximumsPointer: number,
    sizePointer: number,
    capacity: number,
    maxSize: number,
  ): number;
  local_group_aggregate_between_i32_u32(
    filterPointer: number,
    inputKeysPointer: number,
    inputValuesPointer: number,
    inputValiditiesPointer: number,
    hasValidities: number,
    length: number,
    minimum: number,
    maximum: number,
    controlsPointer: number,
    keysPointer: number,
    countsPointer: number,
    nullCountsPointer: number,
    sumsPointer: number,
    minimumsPointer: number,
    maximumsPointer: number,
    sizePointer: number,
    capacity: number,
    maxSize: number,
  ): number;
  local_group_merge_partition(
    destinationControlsPointer: number,
    destinationKeysPointer: number,
    destinationCountsPointer: number,
    destinationNullCountsPointer: number,
    destinationSumsPointer: number,
    destinationMinimumsPointer: number,
    destinationMaximumsPointer: number,
    destinationSizePointer: number,
    destinationCapacity: number,
    destinationMaxSize: number,
    sourceControlsPointer: number,
    sourceKeysPointer: number,
    sourceCountsPointer: number,
    sourceNullCountsPointer: number,
    sourceSumsPointer: number,
    sourceMinimumsPointer: number,
    sourceMaximumsPointer: number,
    sourceCapacity: number,
    partition: number,
    partitionMask: number,
  ): number;
  merge_aggregate_state_blocks(
    destinationCountsPointer: number,
    destinationNullCountsPointer: number,
    destinationSumsPointer: number,
    destinationMinimumsPointer: number,
    destinationMaximumsPointer: number,
    sourceCountsPointer: number,
    sourceNullCountsPointer: number,
    sourceSumsPointer: number,
    sourceMinimumsPointer: number,
    sourceMaximumsPointer: number,
    groupCount: number,
  ): void;
  scan_i32_between_aggregate(
    pointer: number,
    length: number,
    minimum: number,
    maximum: number,
    resultPointer: number,
  ): void;
  scan_adaptive_i32_between_aggregate(
    pointer: number,
    length: number,
    encoding: number,
    bitWidth: number,
    base: number,
    minimum: number,
    maximum: number,
    resultPointer: number,
  ): void;
  aggregate_i32_constant(
    length: number,
    value: number,
    minimum: number,
    maximum: number,
    resultPointer: number,
  ): void;
  scan_i32_between_group_by_u8(
    filterPointer: number,
    valuesPointer: number,
    groupsPointer: number,
    length: number,
    minimum: number,
    maximum: number,
    countsPointer: number,
    sumsPointer: number,
    minimumsPointer: number,
    maximumsPointer: number,
  ): void;
}

let modulePromise: Promise<WebAssembly.Module> | undefined;

export async function instantiateQueryKernels(
  memory: WebAssembly.Memory,
): Promise<QueryKernels> {
  modulePromise ??= compileModule(new URL("./kernels.wasm", import.meta.url));
  return instantiateSharedModule<QueryKernels>(await modulePromise, memory);
}

async function compileModule(url: URL): Promise<WebAssembly.Module> {
  const deno = (globalThis as typeof globalThis & {
    Deno?: { readFile(path: URL): Promise<Uint8Array> };
  }).Deno;
  if (url.protocol === "file:" && deno !== undefined) {
    return await WebAssembly.compile(await deno.readFile(url) as BufferSource);
  }

  interface NodeProcess {
    getBuiltinModule?(name: string): { readFileSync(path: URL): Uint8Array };
  }
  const nodeProcess = (globalThis as typeof globalThis & { process?: NodeProcess }).process;
  const fileSystem = nodeProcess?.getBuiltinModule?.("node:fs");
  if (url.protocol === "file:" && fileSystem !== undefined) {
    return new WebAssembly.Module(fileSystem.readFileSync(url) as BufferSource);
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to load query Wasm module: ${response.status}`);
  return await WebAssembly.compile(await response.arrayBuffer());
}
