import { createEmbeddingWorkload, type EmbeddingDistribution } from "./embedding_workloads.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("embedding workloads are deterministic normalized geometry probes", () => {
  const distributions: EmbeddingDistribution[] = [
    "isotropic-unit",
    "clustered-anisotropic",
    "mean-shifted",
  ];
  for (const distribution of distributions) {
    const first = createEmbeddingWorkload({
      distribution,
      rows: 512,
      dimensions: 32,
      queryCount: 4,
      seed: 17,
    });
    const second = createEmbeddingWorkload({
      distribution,
      rows: 512,
      dimensions: 32,
      queryCount: 4,
      seed: 17,
    });
    assert(first.vectors.join(",") === second.vectors.join(","), `${distribution} deterministic`);
    assert(first.queries.length === 4, `${distribution} query count`);
    assert(Math.abs(first.diagnostics.meanNorm - 1) < 1e-6, `${distribution} normalized`);
    assert(
      first.diagnostics.dominantDimensionVarianceShare > 0,
      `${distribution} variance diagnostic`,
    );
  }
});

Deno.test("workload diagnostics distinguish sign-friendly and biased distributions", () => {
  const isotropic = createEmbeddingWorkload({
    distribution: "isotropic-unit",
    rows: 2_048,
    dimensions: 64,
    queryCount: 2,
  });
  const clustered = createEmbeddingWorkload({
    distribution: "clustered-anisotropic",
    rows: 2_048,
    dimensions: 64,
    queryCount: 2,
  });
  const shifted = createEmbeddingWorkload({
    distribution: "mean-shifted",
    rows: 2_048,
    dimensions: 64,
    queryCount: 2,
  });
  assert(
    isotropic.diagnostics.signOneRate > 0.48 &&
      isotropic.diagnostics.signOneRate < 0.52,
    "isotropic signs stay balanced",
  );
  assert(
    clustered.diagnostics.dominantDimensionVarianceShare >
      isotropic.diagnostics.dominantDimensionVarianceShare * 2,
    "anisotropic variance is concentrated",
  );
  assert(shifted.diagnostics.signOneRate > 0.8, "mean shift makes zero-threshold bits biased");
});

Deno.test("embedding workload validates shape and distribution", () => {
  assertThrows(() =>
    createEmbeddingWorkload({
      distribution: "isotropic-unit",
      rows: 0,
      dimensions: 8,
      queryCount: 1,
    })
  );
  assertThrows(() =>
    createEmbeddingWorkload({
      distribution: "unknown" as EmbeddingDistribution,
      rows: 8,
      dimensions: 8,
      queryCount: 1,
    })
  );
});

function assertThrows(operation: () => unknown): void {
  try {
    operation();
  } catch {
    return;
  }
  throw new Error("expected operation to throw");
}
