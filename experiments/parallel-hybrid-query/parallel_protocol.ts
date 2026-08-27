import type { SharedWorkerLease } from "../../src/shared-buffer/mod.ts";

export interface HybridWorkerInit {
  readonly type: "init";
  readonly memory: WebAssembly.Memory;
  readonly vectorsOffset: number;
  readonly queryOffset: number;
  readonly signaturesOffset: number;
  readonly binaryQueryOffset: number;
  readonly binaryStride: number;
  readonly predicateMaskOffset: number;
  readonly allMaskOffset: number;
  readonly scratchOffset: number;
  readonly resultOffset: number;
  readonly outputIdsOffset: number;
  readonly outputDistancesOffset: number;
  readonly rowStart: number;
  readonly rowCount: number;
  readonly dimensions: number;
}

export interface HybridWorkerSearch {
  readonly type: "search";
  readonly mode: "exact";
  readonly epoch: number;
  readonly generation: number;
  readonly mask: "predicate" | "all";
  readonly selector: "javascript" | "wasm";
  readonly k: number;
}

export interface HybridWorkerBinaryRerank {
  readonly type: "search";
  readonly mode: "binary-rerank";
  readonly epoch: number;
  readonly generation: number;
  readonly k: number;
  readonly candidateCount: number;
}

export interface HybridWorkerStop {
  readonly type: "stop";
}

export type HybridWorkerRequest =
  | HybridWorkerInit
  | HybridWorkerSearch
  | HybridWorkerBinaryRerank
  | HybridWorkerStop;

export type HybridWorkerResponse =
  | { readonly type: "ready"; readonly lease: SharedWorkerLease }
  | {
    readonly type: "result";
    readonly epoch: number;
    readonly ids: readonly number[];
    readonly distances: readonly number[];
    readonly selectedCount: number;
    readonly candidateCount: number;
    readonly exhausted: boolean;
  }
  | { readonly type: "stopped" }
  | { readonly type: "error"; readonly message: string };
