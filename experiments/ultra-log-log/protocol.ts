export interface UltraLogLogWorkerInit {
  readonly type: "init";
  readonly shared: SharedArrayBuffer;
  readonly valuesOffset: number;
  readonly statesOffset: number;
  readonly stateOffset: number;
  readonly precision: number;
  readonly maxValues: number;
}

export type UltraLogLogWorkerOperation =
  | { readonly type: "build"; readonly rowStart: number; readonly rowCount: number }
  | { readonly type: "stop" };

export type UltraLogLogWorkerMessage =
  | UltraLogLogWorkerInit
  | (UltraLogLogWorkerOperation & { readonly requestId: number });

export type UltraLogLogWorkerResponse =
  | { readonly type: "ready" }
  | { readonly type: "built"; readonly requestId: number }
  | { readonly type: "stopped"; readonly requestId: number }
  | { readonly type: "error"; readonly requestId?: number; readonly message: string };
