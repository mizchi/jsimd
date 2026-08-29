import { add, constant, createDynamicWasmFusionCompiler, input } from "./mod.ts";

Deno.test("dynamic fusion compiler bounds and LRU-evicts map modules", async () => {
  const compiler = createDynamicWasmFusionCompiler({
    maxMapModules: 2,
    maxGemmModules: 1,
  });
  const first = await compiler.compileMap(add(input(0), constant(1)), 1);
  const second = await compiler.compileMap(add(input(0), constant(2)), 1);
  assertEquals(compiler.cacheStats(), {
    mapModules: 2,
    gemmModules: 0,
    maxMapModules: 2,
    maxGemmModules: 1,
  });

  assert(await compiler.compileMap(add(input(0), constant(1)), 1) === first);
  await compiler.compileMap(add(input(0), constant(3)), 1);
  assert(await compiler.compileMap(add(input(0), constant(1)), 1) === first);
  assert(await compiler.compileMap(add(input(0), constant(2)), 1) !== second);
  assertEquals(compiler.cacheStats().mapModules, 2);
});

Deno.test("dynamic fusion compiler isolates GEMM caches and clears retained modules", async () => {
  const firstCompiler = createDynamicWasmFusionCompiler({
    maxMapModules: 1,
    maxGemmModules: 1,
  });
  const secondCompiler = createDynamicWasmFusionCompiler({
    maxMapModules: 1,
    maxGemmModules: 1,
  });
  const plan = { rows: 8, inner: 8, columns: 8 } as const;
  const first = await firstCompiler.compileGemm(plan);
  assert(await firstCompiler.compileGemm(plan) === first);
  assert(await secondCompiler.compileGemm(plan) !== first);

  firstCompiler.clearCache();
  assertEquals(firstCompiler.cacheStats().gemmModules, 0);
  assert(await firstCompiler.compileGemm(plan) !== first);
});

Deno.test("dynamic fusion compiler rejects invalid cache bounds", () => {
  assertThrows(
    () => createDynamicWasmFusionCompiler({ maxMapModules: 0, maxGemmModules: 1 }),
    "maxMapModules",
  );
  assertThrows(
    () => createDynamicWasmFusionCompiler({ maxMapModules: 1, maxGemmModules: 1.5 }),
    "maxGemmModules",
  );
});

function assert(condition: boolean, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertThrows(callback: () => unknown, message: string): void {
  try {
    callback();
  } catch (error) {
    if (error instanceof Error && error.message.includes(message)) return;
    throw error;
  }
  throw new Error(`expected error containing ${message}`);
}
