export interface ParallelBloomWorkerModules {
  readonly shared: WebAssembly.Module;
  readonly bloom: WebAssembly.Module;
}

export interface ParallelBloomWorkerInit {
  readonly type: "init";
  readonly memory: WebAssembly.Memory;
  readonly modules: ParallelBloomWorkerModules;
  readonly bitmapOffset: number;
  readonly buildKeysOffset: number;
  readonly shardIndex: number;
}

export type ParallelBloomWorkerOperation =
  | { readonly type: "build"; readonly rowStart: number; readonly rowCount: number }
  | { readonly type: "stop" };

export type ParallelBloomWorkerMessage =
  | ParallelBloomWorkerInit
  | (
    ParallelBloomWorkerOperation & { readonly requestId: number }
  );

export type ParallelBloomWorkerResponse =
  | { readonly type: "ready" }
  | { readonly type: "built"; readonly requestId: number }
  | { readonly type: "stopped"; readonly requestId: number }
  | { readonly type: "error"; readonly requestId?: number; readonly message: string };
