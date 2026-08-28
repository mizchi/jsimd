import { detectHostCpu } from "@mizchi/jsimd-bench/browser-runner";
import { measureResident } from "@mizchi/jsimd-bench/measure";
import { createBenchmarkResult, detectBenchmarkEnvironment } from "@mizchi/jsimd-bench/result";
import {
  defineSchema,
  defineTable,
  MemoryPageBackend,
  SchemaEngine,
  u32,
  type U32OrderMetadata,
} from "@mizchi/jsimd-columnar";
import { RadixSortBlockWorkspace } from "./workspace.ts";

const sizes = [4_096, 65_536, 1_048_576];
const WARMUPS = Number(Deno.env.get("JSIMD_RADIX_WARMUPS") ?? 5);
const SAMPLES = Number(Deno.env.get("JSIMD_RADIX_SAMPLES") ?? 11);
const OPERATIONS = Number(Deno.env.get("JSIMD_RADIX_OPERATIONS") ?? 3);
const HOST_IS_LITTLE_ENDIAN = new Uint8Array(Uint32Array.of(1).buffer)[0] === 1;
const timing = { warmups: WARMUPS, samples: SAMPLES, operationsPerSample: OPERATIONS };
const orderSchema = defineSchema({
  rows: defineTable({ key: u32() }, { rowGroupSize: 65_536 }),
});
const measurements = [];
const metrics: Record<string, number> = {};
let correctnessChecks = 0;
let sink = 0n;

await using workspace = await RadixSortBlockWorkspace.create(Math.max(...sizes));
for (const size of sizes) {
  const u32 = Uint32Array.from(
    { length: size },
    (_, index) => mix32(index ^ size),
  );
  const u64 = BigUint64Array.from(
    { length: size },
    (_, index) => BigInt(mix32(index)) << 32n | BigInt(mix32(index ^ 0x5a5a_5a5a)),
  );
  const jsU32 = new Uint32Array(size);
  const wasmU32 = new Uint32Array(size);
  const jsU64 = new BigUint64Array(size);
  const wasmU64 = new BigUint64Array(size);

  workspace.sortU32Into(u32, wasmU32);
  jsU32.set(u32);
  jsU32.sort();
  assertEqual(wasmU32, jsU32);
  workspace.sortU64Into(u64, wasmU64);
  jsU64.set(u64);
  jsU64.sort();
  assertEqual(wasmU64, jsU64);
  correctnessChecks += 2;

  const u32JsResident = await measureResident(`u32/js-reset+sort/${size}`, timing, () => {
    jsU32.set(u32);
    jsU32.sort();
    sink ^= BigInt(jsU32[0]!);
  });
  const u32WasmResident = await measureResident(`u32/wasm-load+sort/${size}`, timing, () => {
    workspace.loadAndSortU32(u32);
  });
  const u32WasmOutput = await measureResident(`u32/wasm-load+sort+copy-out/${size}`, timing, () => {
    workspace.sortU32Into(u32, wasmU32);
    sink ^= BigInt(wasmU32[0]!);
  });
  const u64JsResident = await measureResident(`u64/js-reset+sort/${size}`, timing, () => {
    jsU64.set(u64);
    jsU64.sort();
    sink ^= jsU64[0]!;
  });
  const u64WasmResident = await measureResident(`u64/wasm-load+sort/${size}`, timing, () => {
    workspace.loadAndSortU64(u64);
  });
  const u64WasmOutput = await measureResident(`u64/wasm-load+sort+copy-out/${size}`, timing, () => {
    workspace.sortU64Into(u64, wasmU64);
    sink ^= wasmU64[0]!;
  });
  measurements.push(
    u32JsResident,
    u32WasmResident,
    u32WasmOutput,
    u64JsResident,
    u64WasmResident,
    u64WasmOutput,
  );
  metrics[`u32_resident_speedup_${size}`] = round(
    u32JsResident.medianMs / u32WasmResident.medianMs,
  );
  metrics[`u32_materialized_speedup_${size}`] = round(
    u32JsResident.medianMs / u32WasmOutput.medianMs,
  );
  metrics[`u64_resident_speedup_${size}`] = round(
    u64JsResident.medianMs / u64WasmResident.medianMs,
  );
  metrics[`u64_materialized_speedup_${size}`] = round(
    u64JsResident.medianMs / u64WasmOutput.medianMs,
  );
}

const distributionSize = Math.max(...sizes);
const distributionInputs = {
  sorted: Uint32Array.from({ length: distributionSize }, (_, index) => index),
  low_cardinality: Uint32Array.from(
    { length: distributionSize },
    (_, index) => mix32(index) & 255,
  ),
  radix_partitioned: Uint32Array.from(
    { length: distributionSize },
    (_, index) =>
      (Math.floor(index / (distributionSize / 16)) << 28 | mix32(index) & 0x0fff_ffff) >>> 0,
  ),
};
for (const [distribution, input] of Object.entries(distributionInputs)) {
  const jsOutput = new Uint32Array(input.length);
  const wasmOutput = new Uint32Array(input.length);
  workspace.sortU32Into(input, wasmOutput);
  jsOutput.set(input);
  jsOutput.sort();
  assertEqual(wasmOutput, jsOutput);
  correctnessChecks++;
  const javascript = await measureResident(`u32/js/${distribution}`, timing, () => {
    jsOutput.set(input);
    jsOutput.sort();
    sink ^= BigInt(jsOutput[0]!);
  });
  const wasm = await measureResident(`u32/wasm/${distribution}`, timing, () => {
    workspace.sortU32Into(input, wasmOutput);
    sink ^= BigInt(wasmOutput[0]!);
  });
  measurements.push(javascript, wasm);
  metrics[`u32_${distribution}_speedup`] = round(javascript.medianMs / wasm.medianMs);
}

for (const size of sizes.slice(1)) {
  const keys = Uint32Array.from({ length: size }, (_, index) => mix32(index ^ size));
  const rowIds = Uint32Array.from({ length: size }, (_, index) => index);
  const javascriptOrder = Array.from(rowIds);
  const javascriptKeys = new Uint32Array(size);
  const javascriptRowIds = new Uint32Array(size);
  const packed = new BigUint64Array(size);
  const packedKeys = new Uint32Array(size);
  const packedRowIds = new Uint32Array(size);
  const wasmKeys = new Uint32Array(size);
  const wasmRowIds = new Uint32Array(size);

  sortJavaScriptOrder(keys, javascriptOrder, javascriptKeys, javascriptRowIds);
  sortPackedJavaScriptOrder(keys, packed, packedKeys, packedRowIds);
  workspace.sortU32PairsInto(keys, rowIds, wasmKeys, wasmRowIds);
  assertEqual(wasmKeys, javascriptKeys);
  assertEqual(wasmRowIds, javascriptRowIds);
  assertEqual(wasmKeys, packedKeys);
  assertEqual(wasmRowIds, packedRowIds);
  correctnessChecks += 4;

  const javascript = await measureResident(`order-u32/js-stable-indices/${size}`, timing, () => {
    for (let index = 0; index < size; index++) javascriptOrder[index] = index;
    sortJavaScriptOrder(keys, javascriptOrder, javascriptKeys, javascriptRowIds);
    sink ^= BigInt(javascriptRowIds[0]!);
  });
  const wasm = await measureResident(`order-u32/wasm-pairs/${size}`, timing, () => {
    workspace.sortU32PairsInto(keys, rowIds, wasmKeys, wasmRowIds);
    sink ^= BigInt(wasmRowIds[0]!);
  });
  const packedJavascript = await measureResident(
    `order-u32/js-packed-u64/${size}`,
    timing,
    () => {
      sortPackedJavaScriptOrder(keys, packed, packedKeys, packedRowIds);
      sink ^= BigInt(packedRowIds[0]!);
    },
  );
  measurements.push(javascript, packedJavascript, wasm);
  metrics[`order_u32_pairs_speedup_vs_comparator_js_${size}`] = round(
    javascript.medianMs / wasm.medianMs,
  );
  metrics[`order_u32_pairs_speedup_vs_packed_js_${size}`] = round(
    packedJavascript.medianMs / wasm.medianMs,
  );
  metrics[`order_u32_pairs_speedup_vs_best_js_${size}`] = round(
    Math.min(javascript.medianMs, packedJavascript.medianMs) / wasm.medianMs,
  );
}

const plannedInputs = {
  uniform_random: Uint32Array.from(
    { length: distributionSize },
    (_, index) => mix32(index ^ distributionSize),
  ),
  ...distributionInputs,
};
const expectedStrategies = {
  uniform_random: "wasm-radix",
  sorted: "already-sorted",
  low_cardinality: "native-packed",
  radix_partitioned: "wasm-radix",
} as const;
for (const [distribution, keys] of Object.entries(plannedInputs)) {
  const metadata = await persistOrderMetadata(keys);
  const baselinePacked = new BigUint64Array(keys.length);
  const baselineKeys = new Uint32Array(keys.length);
  const baselineRowIds = new Uint32Array(keys.length);
  const selectedKeys = new Uint32Array(keys.length);
  const selectedRowIds = new Uint32Array(keys.length);
  const metadataKeys = new Uint32Array(keys.length);
  const metadataRowIds = new Uint32Array(keys.length);
  const expectedStrategy = expectedStrategies[distribution as keyof typeof expectedStrategies];
  const actualStrategy = workspace.orderU32Into(keys, selectedKeys, selectedRowIds);
  const metadataStrategy = workspace.orderU32Into(
    keys,
    metadataKeys,
    metadataRowIds,
    metadata,
  );
  if (actualStrategy !== expectedStrategy) {
    throw new Error(`expected ${expectedStrategy} for ${distribution}, received ${actualStrategy}`);
  }
  if (metadataStrategy !== expectedStrategy) {
    throw new Error(
      `metadata expected ${expectedStrategy} for ${distribution}, received ${metadataStrategy}`,
    );
  }
  if (distribution === "sorted") {
    copySortedOrder(keys, baselineKeys, baselineRowIds);
  } else {
    sortPackedJavaScriptOrder(keys, baselinePacked, baselineKeys, baselineRowIds);
  }
  assertEqual(selectedKeys, baselineKeys);
  assertEqual(selectedRowIds, baselineRowIds);
  assertEqual(metadataKeys, baselineKeys);
  assertEqual(metadataRowIds, baselineRowIds);
  correctnessChecks += 4;

  const baseline = await measureResident(`order-plan/best-js/${distribution}`, timing, () => {
    if (distribution === "sorted") {
      copySortedOrder(keys, baselineKeys, baselineRowIds);
    } else {
      sortPackedJavaScriptOrder(keys, baselinePacked, baselineKeys, baselineRowIds);
    }
    sink ^= BigInt(baselineRowIds[0]!);
  });
  const selected = await measureResident(
    `order-plan/auto:${actualStrategy}/${distribution}`,
    timing,
    () => {
      workspace.orderU32Into(keys, selectedKeys, selectedRowIds);
      sink ^= BigInt(selectedRowIds[0]!);
    },
  );
  const metadataSelected = await measureResident(
    `order-plan/metadata:${metadataStrategy}/${distribution}`,
    timing,
    () => {
      workspace.orderU32Into(keys, metadataKeys, metadataRowIds, metadata);
      sink ^= BigInt(metadataRowIds[0]!);
    },
  );
  measurements.push(baseline, selected, metadataSelected);
  metrics[`order_plan_auto_speedup_${distribution}`] = round(
    baseline.medianMs / selected.medianMs,
  );
  metrics[`order_plan_metadata_speedup_${distribution}`] = round(
    baseline.medianMs / metadataSelected.medianMs,
  );
}

const result = createBenchmarkResult({
  name: "radix-sort-block/u32-u64",
  recordedAt: new Date().toISOString(),
  environment: detectBenchmarkEnvironment({
    logicalCpus: navigator.hardwareConcurrency,
    cpu: await detectHostCpu(),
    adapter: null,
  }),
  timing,
  input: {
    shape: {
      sizes: sizes.join(","),
      distributions: "uniform u32/u64 plus sorted, low-cardinality, and radix-partitioned u32",
    },
  },
  correctness: {
    passed: true,
    checks: correctnessChecks,
    summary: "all unsigned radix outputs match TypedArray.sort",
  },
  measurements,
  metrics: { ...metrics, sink: Number(sink & 0xffff_ffffn) },
  notes: [
    "Every timed operation restores the same unsorted input before sorting.",
    "The resident comparison includes one input copy for both JavaScript and Wasm.",
    "The materialized Wasm row additionally copies the sorted result into caller-owned output.",
    "Workspace/module construction is excluded; histogram clearing and all four/eight radix passes are included.",
    "Distribution rows use the largest size and include caller-owned output for both paths.",
    "ORDER BY rows produce both sorted keys and a stable caller-owned row-ID permutation.",
    "The JavaScript ORDER BY baseline resets and stably sorts number row IDs by their typed-column keys.",
    "A stronger JavaScript baseline packs key and row ID into BigUint64Array, runs native sort, and unpacks both outputs.",
    "Auto planner rows include full distribution inspection and compare with an oracle JS path for each distribution.",
    "Metadata planner rows consume manifest facts persisted once by SchemaEngine; ingestion and manifest reads are excluded.",
  ],
});
const json = JSON.stringify(result, null, 2) + "\n";
const output = Deno.env.get("JSIMD_RADIX_OUTPUT");
if (output !== undefined) await Deno.writeTextFile(output, json);
console.log(json);

function mix32(value: number): number {
  value = Math.imul(value ^ value >>> 16, 0x7feb_352d);
  value = Math.imul(value ^ value >>> 15, 0x846c_a68b);
  return (value ^ value >>> 16) >>> 0;
}

function assertEqual(
  actual: Uint32Array | BigUint64Array,
  expected: Uint32Array | BigUint64Array,
): void {
  if (actual.length !== expected.length) throw new Error("sort length mismatch");
  for (let index = 0; index < actual.length; index++) {
    if (actual[index] !== expected[index]) throw new Error(`sort mismatch at ${index}`);
  }
}

function sortJavaScriptOrder(
  keys: Uint32Array,
  order: number[],
  outputKeys: Uint32Array,
  outputRowIds: Uint32Array,
): void {
  order.sort((left, right) => keys[left]! - keys[right]!);
  for (let index = 0; index < order.length; index++) {
    const rowId = order[index]!;
    outputKeys[index] = keys[rowId]!;
    outputRowIds[index] = rowId;
  }
}

function sortPackedJavaScriptOrder(
  keys: Uint32Array,
  packed: BigUint64Array,
  outputKeys: Uint32Array,
  outputRowIds: Uint32Array,
): void {
  if (HOST_IS_LITTLE_ENDIAN) {
    const words = new Uint32Array(packed.buffer, packed.byteOffset, packed.length * 2);
    for (let index = 0; index < keys.length; index++) {
      words[index * 2] = index;
      words[index * 2 + 1] = keys[index]!;
    }
    packed.sort();
    for (let index = 0; index < packed.length; index++) {
      outputRowIds[index] = words[index * 2]!;
      outputKeys[index] = words[index * 2 + 1]!;
    }
    return;
  }
  for (let index = 0; index < keys.length; index++) {
    packed[index] = BigInt(keys[index]!) << 32n | BigInt(index);
  }
  packed.sort();
  for (let index = 0; index < packed.length; index++) {
    outputRowIds[index] = Number(packed[index]! & 0xffff_ffffn);
    outputKeys[index] = Number(packed[index]! >> 32n);
  }
}

function copySortedOrder(
  keys: Uint32Array,
  outputKeys: Uint32Array,
  outputRowIds: Uint32Array,
): void {
  outputKeys.set(keys);
  for (let index = 0; index < keys.length; index++) outputRowIds[index] = index;
}

async function persistOrderMetadata(keys: Uint32Array): Promise<U32OrderMetadata> {
  const backend = new MemoryPageBackend();
  using engine = new SchemaEngine(orderSchema, backend);
  await engine.replace("rows", { key: keys });
  return await engine.readU32OrderMetadata("rows", "key");
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
