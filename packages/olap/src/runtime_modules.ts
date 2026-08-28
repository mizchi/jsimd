import { compileSharedBufferModule } from "@mizchi/jsimd-shared";
import { compileQueryModule } from "./kernel.ts";

export interface OlapWorkerModules {
  readonly shared: WebAssembly.Module;
  readonly query: WebAssembly.Module;
}

let modulesPromise: Promise<OlapWorkerModules> | undefined;

/** Compiles both Wasm modules once in the coordinator for structured cloning into Workers. */
export function compileOlapWorkerModules(): Promise<OlapWorkerModules> {
  return modulesPromise ??= Promise.all([
    compileSharedBufferModule(),
    compileQueryModule(),
  ]).then(([shared, query]) => ({ shared, query }));
}
