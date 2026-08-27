export const STOP_TASK = 0xffff_ffff;

export interface VectorWorkerInit {
  readonly memory: WebAssembly.Memory;
  readonly ringOffset: number;
  readonly waitGroupOffset: number;
  readonly datasetOffset: number;
  readonly queryOffset: number;
  readonly resultOffset: number;
  readonly rowStart: number;
  readonly rowCount: number;
  readonly dimensions: number;
  readonly k: number;
}

export type VectorWorkerMessage =
  | { readonly phase: "ready"; readonly workerId: number; readonly leaseToken: number }
  | { readonly phase: "stopped" }
  | { readonly phase: "error"; readonly message: string };
