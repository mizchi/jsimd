import { detectHostCpu } from "../../tools/benchmark/browser_runner.ts";
import {
  measureEndToEnd,
  measureMaterializationInclusive,
  measureResident,
} from "../../tools/benchmark/measure.ts";
import { createBenchmarkResult, detectBenchmarkEnvironment } from "../../tools/benchmark/result.ts";
import {
  COLUMNAR_BENCHMARK_GROUP_COUNT,
  COLUMNAR_BENCHMARK_LENGTH,
  COLUMNAR_BENCHMARK_ROW_GROUP_SIZE,
  createColumnarSchemaBenchmarkFixture,
} from "./benchmark_fixture.ts";

const WARMUPS = Number(Deno.env.get("JSIMD_COLUMNAR_WARMUPS") ?? 5);
const SAMPLES = Number(Deno.env.get("JSIMD_COLUMNAR_SAMPLES") ?? 15);
const OPERATIONS_PER_SAMPLE = Number(Deno.env.get("JSIMD_COLUMNAR_OPERATIONS") ?? 10);
const timing = {
  warmups: WARMUPS,
  samples: SAMPLES,
  operationsPerSample: OPERATIONS_PER_SAMPLE,
};
let correctnessChecks = 0;

await using fixture = await createColumnarSchemaBenchmarkFixture();
const check = (value: number) => {
  if (value !== fixture.expectedCount) {
    throw new Error(`columnar benchmark mismatch: ${value} !== ${fixture.expectedCount}`);
  }
  correctnessChecks++;
  return value;
};

const measurements = [
  await measureResident(
    "warm-resident-wasm-count",
    timing,
    async () => check(await fixture.warmResidentCount()),
  ),
  await measureEndToEnd(
    "cold-snapshot-memory-restore-count",
    timing,
    async () => check(await fixture.coldSnapshotMemoryCount()),
  ),
  await measureEndToEnd(
    "cold-raw-memory-rebuild-count",
    timing,
    async () => check(await fixture.coldRawMemoryCount()),
  ),
  await measureEndToEnd(
    "cold-snapshot-filesystem-restore-count",
    timing,
    async () => check(await fixture.coldSnapshotFsCount()),
  ),
  await measureEndToEnd(
    "page-aware-javascript-count",
    timing,
    () => check(fixture.pageAwareJsCount()),
  ),
  await measureEndToEnd(
    "full-javascript-scan-count",
    timing,
    () => check(fixture.fusedJsCount()),
  ),
  await measureMaterializationInclusive(
    "warm-wasm-two-column-projection",
    timing,
    async () => check(await fixture.warmProjection()),
    (value) => value,
  ),
  await measureMaterializationInclusive(
    "page-aware-javascript-two-column-projection",
    timing,
    () => check(fixture.pageAwareJsProject()),
    (value) => value,
  ),
];

const result = createBenchmarkResult({
  name: "columnar-schema-engine/selective-query",
  recordedAt: new Date().toISOString(),
  environment: detectBenchmarkEnvironment({
    logicalCpus: navigator.hardwareConcurrency,
    cpu: await detectHostCpu(),
    adapter: null,
  }),
  timing,
  input: {
    shape: {
      rows: COLUMNAR_BENCHMARK_LENGTH,
      rowGroups: COLUMNAR_BENCHMARK_GROUP_COUNT,
      rowGroupRows: COLUMNAR_BENCHMARK_ROW_GROUP_SIZE,
      selectedRowGroups: 1,
      columns: 3,
    },
    bytes: fixture.inputBytes,
  },
  correctness: {
    passed: true,
    checks: correctnessChecks,
    summary: `every count and projection returned ${fixture.expectedCount} selected rows`,
  },
  measurements,
  metrics: { expectedCount: fixture.expectedCount },
  notes: [
    "Cold restore measurements clear resident host and Wasm pages but reuse an already-populated backend and engine.",
    "The filesystem result can still benefit from operating-system file caching and is not physical cold-disk latency.",
  ],
});
const json = JSON.stringify(result, null, 2) + "\n";
const output = Deno.env.get("JSIMD_COLUMNAR_SCHEMA_OUTPUT");
if (output !== undefined) await Deno.writeTextFile(output, json);
console.log(json);
