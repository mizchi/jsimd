const packageDirectory = new URL("../packages/moonbit-interop/", import.meta.url);
const packageMetadata = JSON.parse(
  await Deno.readTextFile(new URL("package.json", packageDirectory)),
) as { name: string; version: string };

const { compare, equal, find, findByte, findNonAscii, revFind, revFindByte } = await import(
  "../packages/moonbit-interop/dist/mod.js"
);
const input = new TextEncoder().encode("abcabc\u{80}");
if (
  findByte(input, 0x62) !== 1 ||
  find(input, new TextEncoder().encode("cab")) !== 2 ||
  revFindByte(input, 0x62) !== 4 ||
  revFind(input, new TextEncoder().encode("abc")) !== 3 ||
  findNonAscii(input) !== 6 ||
  !equal(input, input.slice()) ||
  compare(new Uint8Array([0x7a]), new Uint8Array([0x61, 0x61])) !== -1
) {
  throw new Error("unexpected MoonBit interop result");
}

const packed = await new Deno.Command("npm", {
  args: ["pack", "--json", "--dry-run", "--ignore-scripts"],
  cwd: packageDirectory,
  stdout: "piped",
  stderr: "piped",
}).output();
if (!packed.success) throw new Error(new TextDecoder().decode(packed.stderr));

const [{ files, size, unpackedSize }] = JSON.parse(new TextDecoder().decode(packed.stdout)) as [{
  files: Array<{ path: string }>;
  size: number;
  unpackedSize: number;
}];
const paths = new Set(files.map((file) => file.path));
for (
  const required of [
    "dist/array_view.d.ts",
    "dist/array_view.js",
    "dist/mod.d.ts",
    "dist/mod.js",
    "dist/string_view.d.ts",
    "dist/string_view.js",
    "README.md",
  ]
) {
  if (!paths.has(required)) throw new Error(`MoonBit interop package is missing ${required}`);
}
for (const path of paths) {
  if (path.includes("_test.")) {
    throw new Error(`MoonBit interop package includes a test file: ${path}`);
  }
}

console.log(
  `${packageMetadata.name}@${packageMetadata.version} dist and npm package smoke passed ` +
    `(${size} bytes packed, ${unpackedSize} bytes unpacked)`,
);
