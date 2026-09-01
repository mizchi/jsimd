const root = new URL("../", import.meta.url);

interface PackageMetadata {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly bin?: Readonly<Record<string, string>>;
  readonly engines?: { readonly node?: string };
  readonly files?: readonly string[];
  readonly keywords?: readonly string[];
}

interface ReleasePleaseConfig {
  readonly "bootstrap-sha": string;
  readonly packages: Record<
    string,
    {
      readonly component: string;
      readonly "package-name": string;
      readonly "changelog-path": string;
      readonly "extra-files": readonly string[];
    }
  >;
}

Deno.test("validator packages expose a Wasm-first release contract", async () => {
  const compiler = await readJson<PackageMetadata>("packages/validator-compiler/package.json");
  const runtime = await readJson<PackageMetadata>("packages/validator/package.json");

  assertMatch(compiler.description, /Binary-oriented.*Wasm SIMD AOT/);
  assertEquals(compiler.bin, {
    "jsimd-validator-compiler": "./bin/jsimd-validator-compiler.js",
  });
  const compilerBin = await readText(
    "packages/validator-compiler/bin/jsimd-validator-compiler.js",
  );
  assertMatch(compilerBin, /from "\.\.\/dist\/cli\.js"/);
  assertMatch(compilerBin, /await main\(/);
  assert(compiler.files?.includes("docs/"), "compiler package must publish its linked docs");
  assertEquals(compiler.engines?.node, ">=24");
  assertEquals(runtime.engines?.node, ">=24");
  for (const keyword of ["wasm", "simd", "aot", "validation", "standard-schema"]) {
    assert(compiler.keywords?.includes(keyword), `compiler metadata is missing ${keyword}`);
  }

  const readme = await readText("packages/validator-compiler/README.md");
  const fitGuide = readme.indexOf("## Where it fits");
  const wasmQuickStart = readme.indexOf("## Quick start: Wasm SIMD AOT");
  const javascriptFallback = readme.indexOf("## JavaScript AOT fallback");
  assert(wasmQuickStart >= 0, "compiler README is missing the Wasm quick start");
  assert(
    fitGuide > wasmQuickStart,
    "compiler README must lead with the primary Wasm AOT workflow before selection guidance",
  );
  assert(
    javascriptFallback > wasmQuickStart,
    "JavaScript fallback must appear after the primary Wasm workflow",
  );
  assertMatch(readme, /pnpm add -D @mizchi\/jsimd-validator-compiler/);
  assertMatch(readme, /pnpm exec jsimd-validator-compiler/);
  assertMatch(readme, /from "\.\/generated\/packet\.js"/);
  assertMatch(readme, /new URL\("\.\/generated\/packet\.wasm"/);
  assertMatch(readme, /Binary-oriented AOT validator/);
  assertMatch(readme, /## Compile all exported schemas/);
  assertMatch(readme, /validators\.Packet\.is\(input\)/);
  assertMatch(readme, /--wasm-opt/);
  assertMatch(readme, /Wasm SIMD AOT is the CLI and programmatic default/);
  assertMatch(readme, /Instantiate once and reuse/);
  assertMatch(readme, /Choose JavaScript AOT instead/);
  assertMatch(readme, /--javascript/);
  assert(
    !/(^|\s)--wasm(?:\s|$)/m.test(readme),
    "the redundant --wasm compatibility flag must stay removed",
  );
  assert(
    !/[ぁ-んァ-ン一-龯]/u.test(readme),
    "the published compiler README must be written in English",
  );
  assert(
    !/abandoned|prototype|legacy|was tested and rejected/i.test(readme),
    "the published compiler README must not read like an implementation history",
  );
  assert(
    readme.split("\n").length <= 180,
    "the compiler README must remain a concise entry point",
  );
  assertMatch(readme, /\.\/docs\/schema-support\.md/);
  assertMatch(readme, /\.\/docs\/backends\.md/);
  assertMatch(readme, /\.\/docs\/performance\.md/);
  assertMatch(readme, /## Performance snapshot/);
  assertMatch(readme, /32 \/ valid.*114\.1 ns/);
  assertMatch(readme, /3\.47 kB.*1\.01 kB/);
  assertMatch(readme, /Shared batch.*12\.47 kB.*1\.67 kB/);

  const detailedDocs = await Promise.all(
    ["schema-support", "backends", "performance"].map((name) =>
      readText(`packages/validator-compiler/docs/${name}.md`)
    ),
  );
  for (const document of detailedDocs) {
    assert(
      !/[ぁ-んァ-ン一-龯]/u.test(document),
      "published compiler docs must be written in English",
    );
  }
  const performance = detailedDocs[2]!;
  assert(
    !performance.includes("| JavaScript AOT |"),
    "the compiler performance comparison must focus on the primary Wasm backend",
  );
  assertMatch(performance, /## Build size/);
  assertMatch(performance, /Zod Mini compile/);
  assertMatch(performance, /gzip total/i);
  assertMatch(performance, /wasm-opt -Oz --enable-simd/);
  assertMatch(performance, /Shared batch/);

  const runtimeReadme = await readText("packages/validator/README.md");
  const runtimeQuickStart = runtimeReadme.indexOf("## Quick start");
  const runtimeScope = runtimeReadme.indexOf("## Scope");
  assert(runtimeQuickStart >= 0, "runtime README is missing its quick start");
  assert(
    runtimeScope > runtimeQuickStart,
    "runtime README must lead with usage before selection guidance",
  );
  assertMatch(runtimeReadme, /from "@mizchi\/jsimd-validator"/);
  assertMatch(runtimeReadme, /from "@mizchi\/jsimd-validator\/debug"/);
  assert(
    !/[ぁ-んァ-ン一-龯]/u.test(runtimeReadme),
    "the published runtime README must be written in English",
  );
  assert(
    !/previous|formerly|legacy|internal asset|experiment/i.test(runtimeReadme),
    "the published runtime README must not read like an implementation history",
  );

  const smoke = await readText("tools/smoke-validator-compiler-package.ts");
  assertMatch(smoke, /--pack-destination/);
  assertMatch(smoke, /node_modules\/.bin\/jsimd-validator-compiler/);
  const runtimeSmoke = await readText("tools/smoke-validator-package.ts");
  assertMatch(runtimeSmoke, /--pack-destination/);
  assertMatch(runtimeSmoke, /from "@mizchi\/jsimd-validator"/);
});

Deno.test("release-please owns only the two validator packages", async () => {
  const config = await readJson<ReleasePleaseConfig>("release-please-config.json");
  const manifest = await readJson<Record<string, string>>(".release-please-manifest.json");
  const expected = ["packages/validator", "packages/validator-compiler"];
  assertEquals(Object.keys(config.packages).sort(), expected);
  assertEquals(Object.keys(manifest).sort(), expected);

  for (const path of expected) {
    const metadata = await readJson<PackageMetadata>(`${path}/package.json`);
    assertEquals(config.packages[path]?.["package-name"], metadata.name);
    assertEquals(config.packages[path]?.["changelog-path"], "CHANGELOG.md");
    assertEquals(config.packages[path]?.["extra-files"], ["deno.json"]);
    assertEquals(manifest[path], metadata.version);
    const denoMetadata = await readJson<PackageMetadata>(`${path}/deno.json`);
    assertEquals(denoMetadata.version, metadata.version);
  }
  assertEquals(config.packages["packages/validator"]?.component, "validator");
  assertEquals(
    config.packages["packages/validator-compiler"]?.component,
    "validator-compiler",
  );

  assertMatch(config["bootstrap-sha"], /^[0-9a-f]{40}$/);
  const bootstrapExists = await new Deno.Command("git", {
    args: ["cat-file", "-e", `${config["bootstrap-sha"]}^{commit}`],
    cwd: root,
    stdout: "null",
    stderr: "null",
  }).output();
  assert(bootstrapExists.success, "release-please bootstrap-sha must name an existing commit");
});

Deno.test("release workflows use an isolated OIDC publish path", async () => {
  const releasePlease = await readText(".github/workflows/release-please.yml");
  assertMatch(releasePlease, /workflow_dispatch:/);
  assertMatch(releasePlease, /pull_request:/);
  assertMatch(releasePlease, /release-please-action@[0-9a-f]{40}/);
  assertMatch(releasePlease, /create-github-app-token@[0-9a-f]{40}/);
  assertMatch(releasePlease, /config-file: release-please-config\.json/);

  const publish = await readText(".github/workflows/publish-validator.yml");
  assertMatch(publish, /release:\s*\n\s+types: \[published\]/);
  assertMatch(publish, /id-token: write/);
  assertMatch(publish, /validator-v\*/);
  assertMatch(publish, /validator-compiler-v\*/);
  assertMatch(publish, /pnpm install --frozen-lockfile/);
  assertMatch(publish, /wasm-tools-1\.245\.1-x86_64-linux\.tar\.gz/);
  assertMatch(publish, /just release-check-validator-packages/);
  assertMatch(publish, /npm publish/);
  assert(!/NPM_TOKEN|NODE_AUTH_TOKEN/.test(publish), "OIDC publish must not use an npm token");

  const releaseGuide = await readText("docs/validator-release.md");
  assertMatch(releaseGuide, /Initial npm publication/);
  assertMatch(releaseGuide, /Trusted Publisher/);
  assertMatch(releaseGuide, /gh workflow run release-please\.yml/);
});

async function readJson<Value>(path: string): Promise<Value> {
  return JSON.parse(await readText(path)) as Value;
}

function readText(path: string): Promise<string> {
  return Deno.readTextFile(new URL(path, root));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`expected ${right}, got ${left}`);
}

function assertMatch(actual: string, expected: RegExp): void {
  if (!expected.test(actual)) {
    throw new Error(`${JSON.stringify(actual)} does not match ${expected}`);
  }
}
