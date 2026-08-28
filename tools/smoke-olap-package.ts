const packageDirectory = new URL("../packages/olap/", import.meta.url);
const packageMetadata = JSON.parse(
  await Deno.readTextFile(new URL("package.json", packageDirectory)),
) as { name: string; version: string; exports: Record<string, unknown> };
const denoMetadata = JSON.parse(
  await Deno.readTextFile(new URL("deno.json", packageDirectory)),
) as { name: string; version: string; exports: Record<string, unknown> };

if (
  packageMetadata.name !== denoMetadata.name || packageMetadata.version !== denoMetadata.version ||
  JSON.stringify(Object.keys(packageMetadata.exports)) !==
    JSON.stringify(Object.keys(denoMetadata.exports))
) throw new Error("OLAP package.json and deno.json release metadata differ");

const { I32AggregatePipeline } = await import(
  "../packages/olap/dist/range_aggregate.js"
);
const values = Int32Array.from({ length: 1_024 }, (_, index) => index);
await using pipeline = await I32AggregatePipeline.create(values, {
  workerCount: 2,
  pageRows: 256,
});
const result = await pipeline.aggregateBetween(100, 200, { execution: "workers" });
if (result.count !== 100 || result.sum !== 14_950n) throw new Error("unexpected OLAP SIMD result");

const { RadixOrderU32 } = await import(
  "../packages/olap/dist/radix_order_u32.js"
);
const orderKeys = Uint32Array.of(9, 1, 9, 2);
const orderedKeys = new Uint32Array(orderKeys.length);
const orderedRows = new Uint32Array(orderKeys.length);
await using order = await RadixOrderU32.create(orderKeys.length);
order.orderInto(orderKeys, orderedKeys, orderedRows, {
  rowCount: orderKeys.length,
  ascending: false,
  adjacentInversions: 2,
  valueRange: 9,
});
if (orderedKeys.join() !== "1,2,9,9" || orderedRows.join() !== "1,3,0,2") {
  throw new Error("unexpected stable radix order result");
}

const packed = await new Deno.Command("npm", {
  args: ["pack", "--json", "--dry-run", "--ignore-scripts"],
  cwd: packageDirectory,
  stdout: "piped",
  stderr: "piped",
}).output();
if (!packed.success) {
  throw new Error(new TextDecoder().decode(packed.stderr));
}
const [{ files, size, unpackedSize }] = JSON.parse(new TextDecoder().decode(packed.stdout)) as [{
  files: Array<{ path: string }>;
  size: number;
  unpackedSize: number;
}];
const paths = new Set(files.map((file) => file.path));
for (
  const required of [
    "dist/group_by_u8.d.ts",
    "dist/group_by_u8.js",
    "dist/group_worker.js",
    "dist/kernels.wasm",
    "dist/range_aggregate.d.ts",
    "dist/range_aggregate.js",
    "dist/radix_order_u32.d.ts",
    "dist/radix_order_u32.js",
    "dist/radix_order_u32.wasm",
    "dist/sparse_group_by_u32.d.ts",
    "dist/sparse_group_by_u32.js",
    "dist/worker.js",
  ]
) {
  if (!paths.has(required)) throw new Error(`OLAP package is missing ${required}`);
}
for (const path of paths) {
  if (path.includes("_test.")) throw new Error(`OLAP package includes a test file: ${path}`);
}

console.log(
  `${packageMetadata.name}@${packageMetadata.version} dist and npm package smoke passed ` +
    `(${size} bytes packed, ${unpackedSize} bytes unpacked)`,
);
