import { SharedBuffer } from "@mizchi/jsimd-shared";
import { instantiateQueryKernels } from "../../packages/olap/src/kernel.ts";
import type { OlapWorkerModules } from "../../packages/olap/src/runtime_modules.ts";

interface WorkerModuleInit {
  readonly memory: WebAssembly.Memory;
  readonly modules?: OlapWorkerModules;
}

self.onmessage = async (event: MessageEvent<WorkerModuleInit>) => {
  self.onmessage = null;
  try {
    const modules = event.data.modules;
    using shared = await SharedBuffer.attach(
      event.data.memory,
      modules === undefined ? {} : { module: modules.shared },
    );
    await instantiateQueryKernels(shared.memory, modules?.query);
    self.postMessage({ ready: true });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  }
};
