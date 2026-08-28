import type { SharedWorkerLease } from "@mizchi/jsimd-shared";
import type { OlapWorkerModules } from "./runtime_modules.ts";

export const STOP_TASK = 0xffff_ffff;

export interface QueryWorkerLayout {
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

export interface QueryWorkerInit extends QueryWorkerLayout {
  readonly modules: OlapWorkerModules;
}

export type QueryWorkerMessage =
  | { readonly phase: "ready"; readonly lease: SharedWorkerLease }
  | { readonly phase: "stopped" }
  | { readonly phase: "error"; readonly message: string };
