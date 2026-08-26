const metadata = JSON.parse(await Deno.readTextFile("package.json")) as {
  name: string;
  version: string;
};
const temporaryDirectory = await Deno.makeTempDir({ prefix: "jsimd-package-smoke-" });

try {
  const packed = await run(
    "npm",
    ["pack", "--silent", "--ignore-scripts", "--pack-destination", temporaryDirectory],
    Deno.cwd(),
  );
  const archive = packed.trim().split("\n").at(-1);
  if (!archive) throw new Error("npm pack did not report an archive");
  await run(
    "npm",
    ["install", "--silent", "--ignore-scripts", `${temporaryDirectory}/${archive}`],
    temporaryDirectory,
  );

  const expression =
    `import { indexOf } from "${metadata.name}/bytes"; import { DenseBitmap } from "${metadata.name}/bitmap"; import { BitHistogram32 } from "${metadata.name}/bit-histogram32"; import { RankSelectBitVector } from "${metadata.name}/rank-select-bit-vector"; import { RoaringBitmap } from "${metadata.name}/roaring-bitmap"; import { AdaptiveU32Column, SelectionMask } from "${metadata.name}/columnar"; import { BlockedVectorArray } from "${metadata.name}/blocked-vector-array"; import { WaveletMatrixUint16 } from "${metadata.name}/wavelet-matrix-uint16"; using bits = DenseBitmap.from(128, [1, 10]); using histogram = new BitHistogram32(); using ranked = RankSelectBitVector.from(128, [1, 10]); using roaring = RoaringBitmap.from([1, 10]); using column = AdaptiveU32Column.from(new Uint32Array([0xffffffff, 1, 2])); using selected = new SelectionMask(3); using vectors = BlockedVectorArray.from(new Float32Array([0, 1, 1, 0]), 2, 2); using wavelet = WaveletMatrixUint16.from(new Uint16Array([3, 1, 2, 1])); const counts = new Uint32Array(32); histogram.add(new Uint32Array([1, 3])).writeInto(counts); const distances = new Float32Array(2); const nearestIds = new Uint32Array(1); const nearestDistances = new Float32Array(1); column.scanLt(3, selected); vectors.squaredDistanceMany(new Float32Array([0, 0]), distances); vectors.topKInto(new Float32Array([0, 0]), nearestIds, nearestDistances); if (indexOf(new Uint8Array([1, 2, 3]), 2) !== 1 || counts[0] !== 2 || bits.countOnes() !== 2 || ranked.rank1(128) !== 2 || roaring.size !== 2 || selected.countOnes() !== 2 || distances[0] !== 1 || distances[1] !== 1 || nearestIds[0] !== 0 || wavelet.rank(1, 4) !== 2) throw new Error("unexpected SIMD result");`;
  await run("node", ["--input-type=module", "--eval", expression], temporaryDirectory);
  await assertImportFails(metadata.name, temporaryDirectory);

  for (
    const removedSubpath of [
      "bitset",
      "bit-vector",
      "rank-select-bitvector",
      "rank-select-bitmap",
      "roaring-uint32-set",
      "static-mphf-bytes",
    ]
  ) {
    await assertImportFails(`${metadata.name}/${removedSubpath}`, temporaryDirectory);
  }

  for (
    const rejectedDirectory of ["static-mphf-bytes", "packed-uint32-array", "packed-delta-array"]
  ) {
    await assertPathMissing(
      `${temporaryDirectory}/node_modules/${metadata.name}/dist/${rejectedDirectory}`,
    );
  }

  const installedModule = `${temporaryDirectory}/node_modules/${metadata.name}/dist/bitmap/mod.js`;
  const installedBytesModule =
    `${temporaryDirectory}/node_modules/${metadata.name}/dist/bytes/mod.js`;
  const denoExpression = `import { DenseBitmap } from ${
    JSON.stringify(installedModule)
  }; import { indexOf } from ${
    JSON.stringify(installedBytesModule)
  }; using bits = DenseBitmap.from(128, [1, 10]); if (bits.countOnes() !== 2 || indexOf(new Uint8Array([1, 2, 3]), 2) !== 1) throw new Error("unexpected SIMD result");`;
  await run("deno", ["eval", denoExpression], temporaryDirectory);

  await Deno.writeTextFile(
    `${temporaryDirectory}/consumer.ts`,
    `import { indexOf } from "${metadata.name}/bytes";
import { DenseBitmap } from "${metadata.name}/bitmap";
import { RankSelectBitVector } from "${metadata.name}/rank-select-bit-vector";
import { RoaringBitmap } from "${metadata.name}/roaring-bitmap";
import { AdaptiveU32Column, SelectionMask } from "${metadata.name}/columnar";
import { BlockedVectorArray } from "${metadata.name}/blocked-vector-array";
import { WaveletMatrixUint16 } from "${metadata.name}/wavelet-matrix-uint16";
using bits = DenseBitmap.from(128, [1, 10]);
using ranked = RankSelectBitVector.from(128, [1, 10]);
using roaring = RoaringBitmap.from([1, 10]);
using column = AdaptiveU32Column.from(new Uint32Array([0xffff_ffff, 1, 2]));
using selected = new SelectionMask(3);
using vectors = BlockedVectorArray.from(new Float32Array([0, 1, 1, 0]), 2, 2);
using wavelet = WaveletMatrixUint16.from(new Uint16Array([3, 1, 2, 1]));
column.scanLt(3, selected);
const nearestIds = new Uint32Array(1);
const nearestDistances = new Float32Array(1);
vectors.topKInto(new Float32Array([0, 0]), nearestIds, nearestDistances);
const count: number = bits.countOnes();
const rank: number = ranked.rank1(128);
const roaringCount: number = roaring.size;
const selectedCount: number = selected.countOnes();
const vectorCount: number = vectors.length;
const byteIndex: number = indexOf(new Uint8Array([1, 2, 3]), 2);
const waveletRank: number = wavelet.rank(1, wavelet.length);
const nearestId: number = nearestIds[0]!;
void count;
void rank;
void roaringCount;
void selectedCount;
void vectorCount;
void byteIndex;
void waveletRank;
void nearestId;
`,
  );
  await run(
    `${Deno.cwd()}/node_modules/.bin/tsc`,
    [
      "--noEmit",
      "--strict",
      "--target",
      "ESNext",
      "--module",
      "ESNext",
      "--moduleResolution",
      "Bundler",
      "consumer.ts",
    ],
    temporaryDirectory,
  );

  console.log(
    `${metadata.name}@${metadata.version} package smoke test passed in Node, Deno, and TypeScript`,
  );
} finally {
  await Deno.remove(temporaryDirectory, { recursive: true });
}

async function run(command: string, args: string[], cwd: string): Promise<string> {
  const result = await new Deno.Command(command, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  if (!result.success) {
    throw new Error(`${command} ${args.join(" ")} failed\n${stdout}${stderr}`);
  }
  return stdout;
}

async function assertImportFails(specifier: string, cwd: string): Promise<void> {
  const result = await new Deno.Command("node", {
    args: ["--input-type=module", "--eval", `await import(${JSON.stringify(specifier)})`],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (result.success) throw new Error(`removed package subpath still resolves: ${specifier}`);
}

async function assertPathMissing(path: string): Promise<void> {
  try {
    await Deno.stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  throw new Error(`rejected implementation was included in the package: ${path}`);
}
