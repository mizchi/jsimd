import type { OlapWorkerModules } from "./runtime_modules.ts";

export interface LocalGroupHashWorkerInit {
  readonly type: "init";
  readonly memory: WebAssembly.Memory;
  readonly modules: OlapWorkerModules;
  readonly partialOffset: number;
  readonly outputOffset: number;
  readonly sourceOffsets: readonly number[];
  readonly partition: number;
  readonly partitionCount: number;
  readonly keysOffset: number;
  readonly valuesOffset: number;
  readonly validitiesOffset: number;
  readonly rowStart: number;
  readonly rowCount: number;
  readonly filterOffset: number | null;
  readonly pages: readonly LocalGroupHashPage[];
}

export interface LocalGroupHashPage {
  readonly rowStart: number;
  readonly rowCount: number;
  readonly minimum: number;
  readonly maximum: number;
}

export type LocalGroupHashWorkerOperation =
  | { readonly type: "aggregate" }
  | { readonly type: "aggregateBetween"; readonly minimum: number; readonly maximum: number }
  | { readonly type: "merge" }
  | { readonly type: "stop" };

export type LocalGroupHashWorkerTask = LocalGroupHashWorkerOperation & {
  readonly requestId: number;
};

export type LocalGroupHashWorkerMessage = LocalGroupHashWorkerInit | LocalGroupHashWorkerTask;

export type LocalGroupHashWorkerResponse =
  | { readonly type: "ready" }
  | {
    readonly type: "result";
    readonly requestId: number;
    readonly pagesScanned: number;
    readonly pagesSkipped: number;
  }
  | { readonly type: "error"; readonly requestId: number; readonly message: string };
