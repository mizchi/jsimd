import { compileOlapWorkerModules } from "./runtime_modules.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("coordinator-compiled OLAP modules instantiate after Worker structured clone", async () => {
  const modules = await compileOlapWorkerModules();
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const source = `
self.onmessage = (event) => {
  try {
    const imports = { jsimd: { memory: event.data.memory } };
    const shared = new WebAssembly.Instance(event.data.modules.shared, imports);
    const query = new WebAssembly.Instance(event.data.modules.query, imports);
    self.postMessage({
      sharedCopy: typeof shared.exports.copy_bytes === "function",
      queryScan: typeof query.exports.scan_i32_between_aggregate === "function",
    });
  } catch (error) {
    self.postMessage({ error: error?.stack ?? String(error) });
  }
};
`;
  const workerUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  const worker = new Worker(workerUrl, { type: "module" });
  try {
    const result = await new Promise<{
      readonly sharedCopy?: boolean;
      readonly queryScan?: boolean;
      readonly error?: string;
    }>((resolve, reject) => {
      worker.onmessage = (event) => resolve(event.data);
      worker.onerror = (event) => reject(event.error ?? new Error(event.message));
      worker.postMessage({ memory, modules });
    });
    if (result.error !== undefined) throw new Error(result.error);
    assert(result.sharedCopy === true, "shared module must instantiate in the Worker");
    assert(result.queryScan === true, "query module must instantiate in the Worker");
  } finally {
    worker.terminate();
    URL.revokeObjectURL(workerUrl);
  }
});
