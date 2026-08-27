export type EmbeddingDistribution =
  | "isotropic-unit"
  | "clustered-anisotropic"
  | "mean-shifted";

export interface EmbeddingWorkloadOptions {
  readonly distribution: EmbeddingDistribution;
  readonly rows: number;
  readonly dimensions: number;
  readonly queryCount: number;
  readonly seed?: number;
}

export interface EmbeddingDiagnostics {
  readonly meanNorm: number;
  readonly signOneRate: number;
  readonly dominantDimensionVarianceShare: number;
}

export interface EmbeddingWorkload {
  readonly distribution: EmbeddingDistribution;
  readonly vectors: Float32Array;
  readonly queries: readonly Float32Array[];
  readonly filters: Int32Array;
  readonly sourceRows: Uint32Array;
  readonly diagnostics: EmbeddingDiagnostics;
}

/**
 * Deterministic synthetic distributions for measuring shortlist recall.
 *
 * These are geometry probes, not substitutes for a domain corpus:
 * - isotropic-unit is the sign-bit-friendly control;
 * - clustered-anisotropic models semantic clusters with concentrated variance;
 * - mean-shifted exposes the failure mode where most zero-threshold sign bits agree.
 */
export function createEmbeddingWorkload(
  options: EmbeddingWorkloadOptions,
): EmbeddingWorkload {
  const rows = positiveInteger(options.rows, "rows");
  const dimensions = positiveInteger(options.dimensions, "dimensions");
  const queryCount = positiveInteger(options.queryCount, "queryCount");
  if (queryCount > rows) throw new RangeError("queryCount must not exceed rows");
  const random = new DeterministicRandom(options.seed ?? 0x1234_5678);
  const vectors = new Float32Array(rows * dimensions);
  if (options.distribution === "isotropic-unit") {
    fillIsotropic(vectors, rows, dimensions, random);
  } else if (options.distribution === "clustered-anisotropic") {
    fillClusteredAnisotropic(vectors, rows, dimensions, random);
  } else if (options.distribution === "mean-shifted") {
    fillMeanShifted(vectors, rows, dimensions, random);
  } else {
    throw new RangeError("unknown embedding distribution");
  }

  const filters = Int32Array.from({ length: rows }, (_, row) => row % 1_000);
  const sourceRows = Uint32Array.from(
    { length: queryCount },
    (_, index) => Math.min(rows - 1, 5_000 % rows + index),
  );
  const queries = Array.from(sourceRows, (sourceRow) => {
    const query = vectors.slice(
      sourceRow * dimensions,
      (sourceRow + 1) * dimensions,
    );
    const noiseScale = options.distribution === "clustered-anisotropic" ? 0.015 : 0.005;
    for (let dimension = 0; dimension < dimensions; dimension++) {
      query[dimension] += random.gaussian() * noiseScale *
        dimensionScale(options.distribution, dimension);
    }
    normalize(query);
    return query;
  });
  return Object.freeze({
    distribution: options.distribution,
    vectors,
    queries: Object.freeze(queries),
    filters,
    sourceRows,
    diagnostics: diagnose(vectors, rows, dimensions),
  });
}

function fillIsotropic(
  output: Float32Array,
  rows: number,
  dimensions: number,
  random: DeterministicRandom,
): void {
  for (let row = 0; row < rows; row++) {
    const vector = output.subarray(row * dimensions, (row + 1) * dimensions);
    for (let dimension = 0; dimension < dimensions; dimension++) {
      vector[dimension] = random.gaussian();
    }
    normalize(vector);
  }
}

function fillClusteredAnisotropic(
  output: Float32Array,
  rows: number,
  dimensions: number,
  random: DeterministicRandom,
): void {
  const clusterCount = Math.min(256, Math.max(8, Math.ceil(Math.sqrt(rows))));
  const centroids = new Float32Array(clusterCount * dimensions);
  for (let cluster = 0; cluster < clusterCount; cluster++) {
    const centroid = centroids.subarray(
      cluster * dimensions,
      (cluster + 1) * dimensions,
    );
    for (let dimension = 0; dimension < dimensions; dimension++) {
      centroid[dimension] = random.gaussian() * dimensionScale(
        "clustered-anisotropic",
        dimension,
      );
    }
    normalize(centroid);
  }
  for (let row = 0; row < rows; row++) {
    const cluster = Math.imul(row + 1, 0x9e37_79b1) >>> 0;
    const centroidOffset = cluster % clusterCount * dimensions;
    const vector = output.subarray(row * dimensions, (row + 1) * dimensions);
    for (let dimension = 0; dimension < dimensions; dimension++) {
      vector[dimension] = centroids[centroidOffset + dimension]! +
        random.gaussian() * 0.08 * dimensionScale("clustered-anisotropic", dimension);
    }
    normalize(vector);
  }
}

function fillMeanShifted(
  output: Float32Array,
  rows: number,
  dimensions: number,
  random: DeterministicRandom,
): void {
  for (let row = 0; row < rows; row++) {
    const vector = output.subarray(row * dimensions, (row + 1) * dimensions);
    for (let dimension = 0; dimension < dimensions; dimension++) {
      const scale = dimensionScale("mean-shifted", dimension);
      vector[dimension] = 0.65 * scale + random.gaussian() * 0.55 * scale;
    }
    normalize(vector);
  }
}

function dimensionScale(
  distribution: EmbeddingDistribution,
  dimension: number,
): number {
  if (distribution === "isotropic-unit") return 1;
  if (distribution === "clustered-anisotropic") return 1 / Math.sqrt(1 + dimension / 6);
  return 1 / Math.sqrt(1 + dimension / 16);
}

function diagnose(
  values: Float32Array,
  rows: number,
  dimensions: number,
): EmbeddingDiagnostics {
  const means = new Float64Array(dimensions);
  const squares = new Float64Array(dimensions);
  let signOnes = 0;
  let normSum = 0;
  for (let row = 0; row < rows; row++) {
    let squaredNorm = 0;
    for (let dimension = 0; dimension < dimensions; dimension++) {
      const value = values[row * dimensions + dimension]!;
      means[dimension] += value;
      squares[dimension] += value * value;
      squaredNorm += value * value;
      signOnes += Number(value > 0);
    }
    normSum += Math.sqrt(squaredNorm);
  }
  let totalVariance = 0;
  let dominantVariance = 0;
  for (let dimension = 0; dimension < dimensions; dimension++) {
    const mean = means[dimension]! / rows;
    const variance = Math.max(0, squares[dimension]! / rows - mean * mean);
    totalVariance += variance;
    if (variance > dominantVariance) dominantVariance = variance;
  }
  return Object.freeze({
    meanNorm: normSum / rows,
    signOneRate: signOnes / (rows * dimensions),
    dominantDimensionVarianceShare: totalVariance === 0 ? 0 : dominantVariance / totalVariance,
  });
}

function normalize(vector: Float32Array): void {
  let squaredNorm = 0;
  for (const value of vector) squaredNorm += value * value;
  if (squaredNorm === 0) {
    vector[0] = 1;
    return;
  }
  const scale = 1 / Math.sqrt(squaredNorm);
  for (let index = 0; index < vector.length; index++) vector[index] *= scale;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

class DeterministicRandom {
  #state: number;
  #spare: number | undefined;

  constructor(seed: number) {
    if (!Number.isSafeInteger(seed)) throw new RangeError("seed must be a safe integer");
    this.#state = seed >>> 0;
  }

  gaussian(): number {
    if (this.#spare !== undefined) {
      const value = this.#spare;
      this.#spare = undefined;
      return value;
    }
    const first = Math.max(Number.EPSILON, this.#uniform());
    const second = this.#uniform();
    const radius = Math.sqrt(-2 * Math.log(first));
    const angle = 2 * Math.PI * second;
    this.#spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  }

  #uniform(): number {
    this.#state = (Math.imul(this.#state, 1_664_525) + 1_013_904_223) >>> 0;
    return (this.#state + 0.5) / 0x1_0000_0000;
  }
}
