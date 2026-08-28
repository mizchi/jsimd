import type { OlapWorkerModules } from "./runtime_modules.ts";

export interface PartitionedHashJoinWorkerInit {
  readonly type: "init";
  readonly memory: WebAssembly.Memory;
  readonly modules: OlapWorkerModules;
  readonly tableOffset: number;
  readonly probeKeysOffset: number;
  readonly probeRowIdsOffset: number;
  readonly rowStart: number;
  readonly rowCount: number;
  readonly outputProbeRowIdsOffset: number;
  readonly outputBuildRowIdsOffset: number;
  readonly outputCapacity: number;
}

export type PartitionedHashJoinWorkerOperation =
  | { readonly type: "probe" }
  | { readonly type: "stop" };

export type PartitionedHashJoinWorkerTask = PartitionedHashJoinWorkerOperation & {
  readonly requestId: number;
};

export type PartitionedHashJoinWorkerMessage =
  | PartitionedHashJoinWorkerInit
  | PartitionedHashJoinWorkerTask;

export type PartitionedHashJoinWorkerResponse =
  | { readonly type: "ready" }
  | {
    readonly type: "result";
    readonly requestId: number;
    readonly matchCount: number;
    readonly written: number;
    readonly truncated: boolean;
  }
  | { readonly type: "error"; readonly requestId: number; readonly message: string };
