import { MultithreadVectorSearch } from "./search.ts";

const VECTOR_COUNT = 8_192;
const DIMENSIONS = 128;
const K = 10;
const WORKER_COUNT = Math.min(4, navigator.hardwareConcurrency || 1);
const MEASURED_QUERIES = 20;

async function main(): Promise<void> {
  if (!crossOriginIsolated) {
    throw new Error(
      "SharedArrayBuffer requires COOP/COEP; run this example through its Vite config",
    );
  }
  const status = requiredElement("status");
  const output = requiredElement("result");
  const values = deterministicVectors(VECTOR_COUNT, DIMENSIONS);
  const buildStarted = performance.now();
  await using search = await MultithreadVectorSearch.create(
    values,
    VECTOR_COUNT,
    DIMENSIONS,
    { workerCount: WORKER_COUNT, k: K },
  );
  const buildMs = performance.now() - buildStarted;

  // Warm every Worker before measuring resident queries.
  await search.search(values.slice(0, DIMENSIONS));
  const samples: number[] = [];
  let lastResult = await search.search(values.slice(0, DIMENSIONS));
  for (let queryIndex = 0; queryIndex < MEASURED_QUERIES; queryIndex++) {
    const row = queryIndex * 97 % VECTOR_COUNT;
    const query = values.slice(row * DIMENSIONS, (row + 1) * DIMENSIONS);
    const started = performance.now();
    lastResult = await search.search(query);
    samples.push(performance.now() - started);
    if (lastResult.ids[0] !== row || lastResult.distances[0] !== 0) {
      throw new Error(`exact row ${row} was not its own nearest neighbor`);
    }
  }

  samples.sort((left, right) => left - right);
  status.textContent = "Ready";
  output.textContent = [
    `vectors: ${VECTOR_COUNT.toLocaleString()} × ${DIMENSIONS}`,
    `workers: ${WORKER_COUNT}`,
    `top-k: ${K}`,
    `build: ${buildMs.toFixed(2)} ms`,
    `query median: ${percentile(samples, 0.5).toFixed(3)} ms`,
    `query p99: ${percentile(samples, 0.99).toFixed(3)} ms`,
    `last IDs: ${[...lastResult.ids].join(", ")}`,
    `last distances: ${[...lastResult.distances].map((value) => value.toFixed(3)).join(", ")}`,
  ].join("\n");
}

function deterministicVectors(count: number, dimensions: number): Float32Array {
  const output = new Float32Array(count * dimensions);
  let state = 0x1234_5678;
  for (let index = 0; index < output.length; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    output[index] = ((state >>> 8) / 0x100_0000) * 2 - 1;
  }
  return output;
}

function percentile(values: readonly number[], quantile: number): number {
  return values[Math.min(values.length - 1, Math.ceil(values.length * quantile) - 1)]!;
}

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`missing #${id}`);
  return element;
}

void main().catch((error) => {
  requiredElement("status").textContent = "Failed";
  requiredElement("result").textContent = error instanceof Error
    ? error.stack ?? error.message
    : String(error);
});
