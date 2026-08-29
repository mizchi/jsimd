import { detectHostCpu } from "@mizchi/jsimd-bench/browser-runner";
import { summarizeBenchmarkSamples } from "@mizchi/jsimd-bench/measure";
import { createBenchmarkResult } from "@mizchi/jsimd-bench/result";
import type { F32GemmRowTile } from "./mod.ts";

const SHAPES = [
  { name: "16x16x16", rows: 16, inner: 16, columns: 16 },
  { name: "64x64x64", rows: 64, inner: 64, columns: 64 },
  { name: "128x128x128", rows: 128, inner: 128, columns: 128 },
  { name: "256x128x32", rows: 256, inner: 128, columns: 32 },
  { name: "32x128x256", rows: 32, inner: 128, columns: 256 },
] as const;
const ROW_TILES = [1, 2, 4, 8] as const satisfies readonly F32GemmRowTile[];
const target = Deno.env.get("JSIMD_FUSION_TILE_RUNTIME") ?? "deno";
if (target !== "deno" && target !== "node") throw new Error("runtime must be deno or node");
const warmups = positiveInteger(Deno.env.get("JSIMD_FUSION_TILE_WARMUPS") ?? "256", "warmups");
const samples = positiveInteger(Deno.env.get("JSIMD_FUSION_TILE_SAMPLES") ?? "31", "samples");
const operations = positiveInteger(
  Deno.env.get("JSIMD_FUSION_TILE_OPERATIONS") ?? "16",
  "operations",
);
const measurements = [];
const metrics: Record<string, number> = {};
const candidateUrl = new URL("./gemm_tile_candidate.ts", import.meta.url);
let runtime: Readonly<{ name: string; version: string }> | undefined;
let checksum = 0;

for (const shape of SHAPES) {
  const shapeMeasurements = [];
  for (const rowTile of ROW_TILES) {
    const raw = await runCandidate(target, candidateUrl, {
      ...shape,
      rowTile,
      warmups,
      samples,
      operations,
    });
    runtime ??= raw.runtime;
    if (raw.runtime.name !== runtime.name || raw.runtime.version !== runtime.version) {
      throw new Error("candidate runtime changed during isolated benchmark");
    }
    checksum += raw.checksum;
    const measurement = summarizeBenchmarkSamples(
      `gemm-row-tile-isolated/${shape.name}/mr${rowTile}nr${32 / rowTile}`,
      "resident",
      raw.samplesMs,
    );
    measurements.push(measurement);
    shapeMeasurements.push(measurement);
    metrics[`${shape.name}_mr${rowTile}_ms`] = round(measurement.medianMs, 6);
    metrics[`${shape.name}_mr${rowTile}_module_bytes`] = raw.moduleBytes;
  }
  const baseline = shapeMeasurements[0]!.medianMs;
  let bestIndex = 0;
  for (let index = 1; index < shapeMeasurements.length; index++) {
    if (shapeMeasurements[index]!.medianMs < shapeMeasurements[bestIndex]!.medianMs) {
      bestIndex = index;
    }
  }
  metrics[`${shape.name}_best_row_tile`] = ROW_TILES[bestIndex]!;
  metrics[`${shape.name}_best_speedup_vs_mr1`] = round(
    baseline / shapeMeasurements[bestIndex]!.medianMs,
  );
}

metrics.checksum = round(Math.abs(checksum), 3);
const result = createBenchmarkResult({
  name: `dynamic-wasm-fusion/gemm-row-tiles-isolated-${target}`,
  recordedAt: new Date().toISOString(),
  environment: {
    runtime: runtime!,
    platform: Deno.build.target,
    logicalCpus: navigator.hardwareConcurrency,
    cpu: await detectHostCpu(),
    adapter: null,
  },
  timing: { warmups, samples, operationsPerSample: operations },
  input: {
    shape: {
      rows: SHAPES.map((shape) => shape.rows),
      inner: SHAPES.map((shape) => shape.inner),
      columns: SHAPES.map((shape) => shape.columns),
      rowTiles: ROW_TILES,
      isolation: "fresh process per shape and row tile",
    },
    bytes: Math.max(
      ...SHAPES.map((shape) =>
        (shape.rows * shape.inner + shape.inner * shape.columns + shape.rows * shape.columns) * 4
      ),
    ),
  },
  correctness: {
    passed: true,
    checks: SHAPES.length * ROW_TILES.length,
    summary: "each isolated candidate validates its final output cell against scalar f32 GEMM",
  },
  measurements,
  metrics,
  notes: [
    "Every shape/tile candidate runs in a fresh runtime process to isolate JIT tiering and module caches.",
    "Timing is resident and excludes process startup, module compilation, instantiation, and input creation.",
    "All candidates use row-major B, strict SIMD, a compact K loop, and eight v128 accumulators.",
  ],
});
const json = JSON.stringify(result, null, 2) + "\n";
const output = Deno.env.get("JSIMD_FUSION_TILE_ISOLATED_OUTPUT");
if (output !== undefined) await Deno.writeTextFile(output, json);
if (Deno.env.get("JSIMD_FUSION_TILE_SUMMARY") === "1") console.log(JSON.stringify(metrics));
else console.log(json);

interface RawCandidate {
  readonly moduleBytes: number;
  readonly samplesMs: readonly number[];
  readonly checksum: number;
  readonly runtime: Readonly<{ name: string; version: string }>;
}

async function runCandidate(
  runtime: "deno" | "node",
  candidate: URL,
  options: Readonly<{
    rows: number;
    inner: number;
    columns: number;
    rowTile: F32GemmRowTile;
    warmups: number;
    samples: number;
    operations: number;
  }>,
): Promise<RawCandidate> {
  const arguments_ = [
    `--rows=${options.rows}`,
    `--inner=${options.inner}`,
    `--columns=${options.columns}`,
    `--row-tile=${options.rowTile}`,
    `--warmups=${options.warmups}`,
    `--samples=${options.samples}`,
    `--operations=${options.operations}`,
  ];
  const command = runtime === "deno"
    ? new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", candidate.pathname, ...arguments_],
      stdout: "piped",
      stderr: "piped",
    })
    : new Deno.Command("node", {
      args: [candidate.pathname, ...arguments_],
      stdout: "piped",
      stderr: "piped",
    });
  const output = await command.output();
  if (!output.success) {
    throw new Error(new TextDecoder().decode(output.stderr) || `${runtime} candidate failed`);
  }
  const raw = JSON.parse(new TextDecoder().decode(output.stdout)) as Partial<RawCandidate>;
  if (
    !Number.isSafeInteger(raw.moduleBytes) || !Array.isArray(raw.samplesMs) ||
    !raw.samplesMs.every((sample) => Number.isFinite(sample) && sample >= 0) ||
    !Number.isFinite(raw.checksum) || typeof raw.runtime?.name !== "string" ||
    typeof raw.runtime.version !== "string"
  ) throw new Error("invalid isolated candidate result");
  return raw as RawCandidate;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be positive`);
  return parsed;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
