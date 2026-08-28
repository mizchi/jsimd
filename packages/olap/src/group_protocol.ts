import type { SharedWorkerLease } from "@mizchi/jsimd-shared";

export const GROUP_STOP_TASK = 0xffff_ffff;

export interface GroupQueryWorkerInit {
  readonly memory: WebAssembly.Memory;
  readonly ringOffset: number;
  readonly waitGroupOffset: number;
  readonly queryOffset: number;
  readonly snapshotOffset: number;
  readonly snapshotDescriptorOffset: number;
  readonly pageCount: number;
  readonly resultOffset: number;
  readonly groupCount: number;
}

export type GroupQueryWorkerMessage =
  | { readonly phase: "ready"; readonly lease: SharedWorkerLease }
  | { readonly phase: "stopped" }
  | { readonly phase: "error"; readonly message: string };
