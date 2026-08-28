export interface RoaringPairInput {
  readonly left: Uint32Array;
  readonly right: Uint32Array;
}

export interface StripedRoaringWorkerInit {
  readonly type: "init";
  readonly pairs: readonly RoaringPairInput[];
}

export type StripedRoaringWorkerOperation =
  | { readonly type: "intersections" }
  | { readonly type: "stop" };

export type StripedRoaringWorkerMessage =
  | StripedRoaringWorkerInit
  | (StripedRoaringWorkerOperation & { readonly requestId: number });

export type StripedRoaringWorkerResponse =
  | { readonly type: "ready" }
  | { readonly type: "intersections"; readonly requestId: number; readonly counts: Float64Array }
  | { readonly type: "stopped"; readonly requestId: number }
  | { readonly type: "error"; readonly requestId?: number; readonly message: string };
