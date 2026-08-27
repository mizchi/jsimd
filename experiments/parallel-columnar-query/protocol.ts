import type { SharedWorkerLease } from "../../src/shared-buffer/mod.ts";

export const STOP_TASK = 0xffff_ffff;

export interface QueryWorkerInit {
  readonly memory: WebAssembly.Memory;
  readonly ringOffset: number;
  readonly waitGroupOffset: number;
  readonly queryOffset: number;
  readonly snapshotOffset: number;
  readonly snapshotDescriptorOffset: number;
  readonly pageCount: number;
  readonly resultOffset: number;
  readonly workerIndex: number;
}

export type QueryWorkerMessage =
  | { readonly phase: "ready"; readonly lease: SharedWorkerLease }
  | { readonly phase: "stopped" }
  | { readonly phase: "error"; readonly message: string };
