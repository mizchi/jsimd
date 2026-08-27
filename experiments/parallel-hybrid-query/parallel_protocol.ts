import type { SharedWorkerLease } from "../../src/shared-buffer/mod.ts";

export interface HybridWorkerInit {
  readonly type: "init";
  readonly memory: WebAssembly.Memory;
  readonly vectorsOffset: number;
  readonly queryOffset: number;
  readonly predicateMaskOffset: number;
  readonly allMaskOffset: number;
  readonly scratchOffset: number;
  readonly resultOffset: number;
  readonly rowStart: number;
  readonly rowCount: number;
  readonly dimensions: number;
}

export interface HybridWorkerSearch {
  readonly type: "search";
  readonly epoch: number;
  readonly generation: number;
  readonly mask: "predicate" | "all";
  readonly k: number;
}

export interface HybridWorkerStop {
  readonly type: "stop";
}

export type HybridWorkerRequest = HybridWorkerInit | HybridWorkerSearch | HybridWorkerStop;

export type HybridWorkerResponse =
  | { readonly type: "ready"; readonly lease: SharedWorkerLease }
  | {
    readonly type: "result";
    readonly epoch: number;
    readonly ids: readonly number[];
    readonly distances: readonly number[];
    readonly selectedCount: number;
    readonly exhausted: boolean;
  }
  | { readonly type: "stopped" }
  | { readonly type: "error"; readonly message: string };
