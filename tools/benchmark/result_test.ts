import {
  createBenchmarkResult,
  detectBenchmarkEnvironment,
  validateBenchmarkResult,
} from "./result.ts";
import {
  measureConstructionInclusive,
  measureEndToEnd,
  measureMaterializationInclusive,
  measureResident,
} from "./measure.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("benchmark boundaries keep setup, execution, and materialization explicit", async () => {
  let clock = 0;
  let residentRuns = 0;
  const timing = { warmups: 2, samples: 3, operationsPerSample: 1, now: () => clock };
  const resident = await measureResident("resident", timing, () => {
    residentRuns++;
    clock += residentRuns;
  });
  assert(residentRuns === 5, "resident warmups and samples");
  assert(resident.boundary === "resident", "resident boundary");
  assert(resident.medianMs === 4, `resident median: ${resident.medianMs}`);

  const events: string[] = [];
  const construction = await measureConstructionInclusive(
    "construction",
    { warmups: 0, samples: 1, now: () => clock },
    () => {
      events.push("construct");
      clock += 2;
      return { [Symbol.dispose]: () => events.push("dispose") };
    },
    () => {
      events.push("run");
      clock += 3;
    },
  );
  assert(events.join(",") === "construct,run,dispose", "construction lifecycle");
  assert(construction.medianMs === 5, "construction timing includes setup and run");

  const materialized = await measureMaterializationInclusive(
    "materialized",
    { warmups: 0, samples: 1, now: () => clock },
    () => {
      clock += 7;
      return new Uint32Array([1, 2]);
    },
    (value) => {
      assert(value.length === 2, "materializer input");
      clock += 11;
      return Array.from(value);
    },
  );
  assert(materialized.medianMs === 18, "materialization is inside the boundary");
});

Deno.test("versioned benchmark result records environment, shape, correctness, and end-to-end", async () => {
  let clock = 0;
  const endToEnd = await measureEndToEnd(
    "query",
    { warmups: 1, samples: 2, now: () => clock },
    () => clock += 2,
  );
  const environment = detectBenchmarkEnvironment({
    runtimeName: "test-browser",
    runtimeVersion: "1.2.3",
    userAgent: "TestBrowser/1.2.3",
    logicalCpus: 8,
    cpu: "Test CPU",
    adapter: { vendor: "Test GPU", architecture: "simd128" },
  });
  const result = createBenchmarkResult({
    name: "unit/example",
    recordedAt: "2026-08-27T00:00:00.000Z",
    environment,
    timing: { warmups: 1, samples: 2, operationsPerSample: 1 },
    input: { shape: { rows: 1024, dimensions: 128 }, bytes: 524_288 },
    correctness: { passed: true, checks: 2, summary: "IDs matched" },
    measurements: [endToEnd],
  });
  assert(result.schemaVersion === 1, "schema version");
  assert(result.environment.cpu === "Test CPU", "CPU descriptor");
  assert(result.environment.adapter?.vendor === "Test GPU", "adapter descriptor");
  assert(detectBenchmarkEnvironment({ adapter: null }).adapter === null, "explicit no adapter");
  validateBenchmarkResult(JSON.parse(JSON.stringify(result)));
  assertThrows(() =>
    validateBenchmarkResult({
      ...result,
      correctness: { passed: false, checks: 0 },
    })
  );
  assertThrows(() => createBenchmarkResult({ ...result, measurements: [] }));
});

function assertThrows(operation: () => unknown): void {
  try {
    operation();
  } catch {
    return;
  }
  throw new Error("expected operation to throw");
}
