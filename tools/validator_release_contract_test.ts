const root = new URL("../", import.meta.url);

interface PackageMetadata {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly bin?: Readonly<Record<string, string>>;
  readonly engines?: { readonly node?: string };
  readonly files?: readonly string[];
  readonly keywords?: readonly string[];
  readonly license?: string;
  readonly publishConfig?: { readonly access?: string };
  readonly repository?: {
    readonly type: string;
    readonly url: string;
    readonly directory?: string;
  };
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

Deno.test("validator packages carry the metadata tag releases depend on", async () => {
  for (const directory of ["validator", "validator-compiler"]) {
    const path = `packages/${directory}`;
    const metadata = await readJson<PackageMetadata>(`${path}/package.json`);
    const denoMetadata = await readJson<PackageMetadata>(`${path}/deno.json`);
    assertEquals(denoMetadata.name, metadata.name);
    assertEquals(denoMetadata.version, metadata.version);
    assertEquals(metadata.license, "MIT");
    assertEquals(metadata.publishConfig?.access, "public");
    assertEquals(metadata.repository, {
      type: "git",
      url: "git+https://github.com/mizchi/jsimd.git",
      directory: path,
    });
    assert(metadata.files?.includes("dist/"), `${path} must publish dist/`);
  }
});

Deno.test("release-please is retired", async () => {
  for (
    const path of [
      ".github/workflows/release-please.yml",
      "release-please-config.json",
      ".release-please-manifest.json",
    ]
  ) {
    assert(!await exists(path), `${path} must stay removed`);
  }
  for (const path of [".github/workflows/validator.yml", "docs/validator-release.md", "justfile"]) {
    assert(
      !/release-please|RELEASE_PLEASE/.test(await readText(path)),
      `${path} still refers to release-please`,
    );
  }
});

Deno.test("tag pushes publish through an isolated OIDC path", async () => {
  const publish = await readText(".github/workflows/publish-validator.yml");
  assertMatch(publish, /\non:\n  push:\n    tags:\n/);
  assertMatch(publish, /- "validator-v\*"/);
  assertMatch(publish, /- "validator-compiler-v\*"/);
  assert(
    !/\n  (release|workflow_dispatch|pull_request|schedule):/.test(publish),
    "tag pushes must be the only publish trigger",
  );
  assertMatch(publish, /\n    permissions:\n      contents: write.*\n      id-token: write/);
  assertMatch(publish, /registry-url: "https:\/\/registry\.npmjs\.org"/);
  assertMatch(publish, /pnpm install --frozen-lockfile/);
  assertMatch(publish, /wasm-tools-1\.245\.1-x86_64-linux\.tar\.gz/);
  assertMatch(publish, /apt-get install .*ripgrep/);
  assertMatch(publish, /just release-check-validator-packages/);
  assertMatch(publish, /npm install --global npm@11/);
  assertMatch(publish, /pnpm pack --pack-destination/);
  assertMatch(publish, /npm publish "\$1" --access public --tag next/);
  assertMatch(publish, /npm publish "\$1" --access public ;;/);
  assertMatch(publish, /gh release create .* --notes-file /);
  assertMatch(publish, /gh release create .* --generate-notes/);
  assert(
    !/NPM_TOKEN|NODE_AUTH_TOKEN|secrets\.|create-github-app-token/.test(publish),
    "OIDC publish must not use an npm token, repository secret, or GitHub App token",
  );
  for (const [, reference] of publish.matchAll(/uses: (\S+)/g)) {
    assertMatch(reference!, /@[0-9a-f]{40}$/);
  }

  const cliff = await readText("cliff.toml");
  assertMatch(cliff, /tag_pattern = "\^validator\(-compiler\)\?-v\[0-9\]"/);

  const recipes = await readText("justfile");
  assertMatch(recipes, /\nrelease-prepare-validator-package component version:\n/);
  assertMatch(recipes, /--tag-pattern '\^\{\{ component \}\}-v\[0-9\]'/);
  assertMatch(recipes, /--include-path 'packages\/\{\{ component \}\}\/\*\*'/);

  const releaseGuide = await readText("docs/validator-release.md");
  assertMatch(releaseGuide, /Trusted Publisher/);
  assertMatch(releaseGuide, /publish-validator\.yml/);
  assertMatch(releaseGuide, /just release-prepare-validator-package/);
  assertMatch(releaseGuide, /git push origin main validator-v/);
  assertMatch(releaseGuide, /git push origin main validator-compiler-v/);
});

async function readJson<Value>(path: string): Promise<Value> {
  return JSON.parse(await readText(path)) as Value;
}

function readText(path: string): Promise<string> {
  return Deno.readTextFile(new URL(path, root));
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(new URL(path, root));
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
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
