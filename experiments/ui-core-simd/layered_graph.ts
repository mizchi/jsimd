export interface LayeredGraphShape {
  readonly width: number;
  readonly depth: number;
  readonly inputCount: number;
  readonly dependenciesPerNode: number;
}

export interface LayeredGraphStats {
  readonly computedCount: number;
  readonly outputCount: number;
  readonly signalCount: number;
  readonly effectCount: number;
  readonly subscriptionCount: number;
  readonly denseSignalCount: number;
  readonly denseMatrixBytes: number;
  readonly fullDenseMatrixBytes: number;
}

export function validateLayeredGraphShape(shape: LayeredGraphShape): void {
  for (const [name, value] of Object.entries(shape)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
  if (
    shape.dependenciesPerNode > shape.inputCount ||
    (shape.depth > 1 && shape.dependenciesPerNode > shape.width)
  ) {
    throw new RangeError("dependenciesPerNode must fit every source layer");
  }
  if (!Number.isSafeInteger(shape.width * shape.depth)) {
    throw new RangeError("layered graph is too large");
  }
}

export function layeredGraphStats(shape: LayeredGraphShape): LayeredGraphStats {
  validateLayeredGraphShape(shape);
  const computedCount = shape.width * shape.depth;
  const outputCount = shape.width;
  const signalCount = shape.inputCount + computedCount;
  const effectCount = computedCount + outputCount;
  const subscriptionCount = computedCount * shape.dependenciesPerNode + outputCount;
  const wordsPerRow = Math.ceil(effectCount / 32);
  const alignedWordsPerRow = (wordsPerRow + 3) & ~3;
  let denseSignalCount = 0;
  for (let depth = 0; depth < shape.depth; depth++) {
    const sourceCount = depth === 0 ? shape.inputCount : shape.width;
    const fanouts = new Uint32Array(sourceCount);
    for (let index = 0; index < shape.width; index++) {
      for (
        const signalId of dependencyIds(
          sourceCount,
          index + depth * shape.width,
          shape.dependenciesPerNode,
        )
      ) fanouts[signalId]++;
    }
    for (const fanout of fanouts) if (fanout >= alignedWordsPerRow) denseSignalCount++;
  }
  const denseMatrixBytes = denseSignalCount * alignedWordsPerRow * Uint32Array.BYTES_PER_ELEMENT;
  const fullDenseMatrixBytes = signalCount * alignedWordsPerRow * Uint32Array.BYTES_PER_ELEMENT;
  return {
    computedCount,
    outputCount,
    signalCount,
    effectCount,
    subscriptionCount,
    denseSignalCount,
    denseMatrixBytes,
    fullDenseMatrixBytes,
  };
}

export function layeredDependencyIds(
  sourceCount: number,
  effectId: number,
  dependencyCount: number,
): readonly number[] {
  if (!Number.isSafeInteger(sourceCount) || sourceCount < 1) {
    throw new RangeError("sourceCount must be a positive safe integer");
  }
  if (!Number.isSafeInteger(effectId) || effectId < 0) {
    throw new RangeError("effectId must be a non-negative safe integer");
  }
  if (
    !Number.isSafeInteger(dependencyCount) || dependencyCount < 1 ||
    dependencyCount > sourceCount
  ) {
    throw new RangeError("dependencyCount must fit within sourceCount");
  }
  return dependencyIds(sourceCount, effectId, dependencyCount);
}

function dependencyIds(sourceCount: number, effectId: number, dependencyCount: number): number[] {
  const result: number[] = [];
  for (let offset = 0; offset < dependencyCount; offset++) {
    let signalId = (effectId * 5 + offset * 3) % sourceCount;
    while (result.includes(signalId)) signalId = (signalId + 1) % sourceCount;
    result.push(signalId);
  }
  return result;
}
