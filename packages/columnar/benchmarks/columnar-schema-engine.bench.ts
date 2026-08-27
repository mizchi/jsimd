import { afterAll, bench, describe } from "vitest";
import { createColumnarSchemaBenchmarkFixture } from "./benchmark_fixture.ts";

const fixture = await createColumnarSchemaBenchmarkFixture();
let sink = 0;

describe("columnar schema engine selective count over 4M rows", () => {
  bench("warm resident Wasm query", async () => {
    sink ^= await fixture.warmResidentCount();
  });
  bench(
    "cold snapshot Memory restore + Wasm query",
    async () => {
      sink ^= await fixture.coldSnapshotMemoryCount();
    },
  );
  bench(
    "cold raw Memory rebuild + Wasm query",
    async () => {
      sink ^= await fixture.coldRawMemoryCount();
    },
  );
  bench(
    "cold snapshot FS restore + Wasm query",
    async () => {
      sink ^= await fixture.coldSnapshotFsCount();
    },
  );
  bench("page-aware typed-array JS query", () => {
    sink ^= fixture.pageAwareJsCount();
  });
  bench("fused full typed-array JS scan", () => {
    sink ^= fixture.fusedJsCount();
  });
});

describe("selective projection materialization", () => {
  bench(
    "warm schema query + two-column projection",
    async () => {
      sink ^= await fixture.warmProjection();
    },
  );
  bench("page-aware JS + two-column projection", () => {
    sink ^= fixture.pageAwareJsProject();
  });
});

afterAll(async () => {
  await fixture[Symbol.asyncDispose]();
  if (sink === -1) console.log(sink);
});
