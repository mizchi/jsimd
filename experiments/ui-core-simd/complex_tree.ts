export interface ComplexTreeLeaf {
  readonly kind: "leaf";
  readonly index: number;
}

export interface ComplexTreeBranch {
  readonly kind: "branch";
  readonly depth: number;
  readonly children: readonly ComplexTreeNode[];
}

export type ComplexTreeNode = ComplexTreeLeaf | ComplexTreeBranch;

export interface ComplexTreeStats {
  readonly leaves: number;
  readonly branches: number;
  readonly maxDepth: number;
}

export function createComplexTreePlan(leafCount: number, branching = 4): ComplexTreeNode {
  if (!Number.isSafeInteger(leafCount) || leafCount < 1) {
    throw new RangeError("leafCount must be a positive safe integer");
  }
  if (!Number.isSafeInteger(branching) || branching < 2) {
    throw new RangeError("branching must be a safe integer of at least two");
  }
  let remaining = leafCount;
  while (remaining > 1) {
    if (remaining % branching !== 0) {
      throw new RangeError("leafCount must be an exact power of branching");
    }
    remaining /= branching;
  }
  return buildBranch(0, leafCount, branching, 0);
}

export function dependencyIds(
  signalCount: number,
  leafIndex: number,
  bindingIndex: number,
  dependencyCount: number,
): readonly number[] {
  if (!Number.isSafeInteger(signalCount) || signalCount < 1) {
    throw new RangeError("signalCount must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(dependencyCount) || dependencyCount < 1 || dependencyCount > signalCount
  ) {
    throw new RangeError("dependencyCount must fit within signalCount");
  }
  if (!Number.isSafeInteger(leafIndex) || leafIndex < 0) {
    throw new RangeError("leafIndex must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(bindingIndex) || bindingIndex < 0) {
    throw new RangeError("bindingIndex must be a non-negative safe integer");
  }
  const result: number[] = [];
  for (let offset = 0; offset < dependencyCount; offset++) {
    let signalId = (leafIndex * 5 + bindingIndex * 7 + offset * 11) % signalCount;
    while (result.includes(signalId)) signalId = (signalId + 1) % signalCount;
    result.push(signalId);
  }
  return result;
}

export function complexTreeStats(root: ComplexTreeNode): ComplexTreeStats {
  return visitTree(root, 0);
}

function visitTree(root: ComplexTreeNode, depth: number): ComplexTreeStats {
  if (root.kind === "leaf") return { leaves: 1, branches: 0, maxDepth: depth };
  let leaves = 0;
  let branches = 1;
  let maxDepth = depth;
  for (const child of root.children) {
    const stats = visitTree(child, depth + 1);
    leaves += stats.leaves;
    branches += stats.branches;
    maxDepth = Math.max(maxDepth, stats.maxDepth);
  }
  return { leaves, branches, maxDepth };
}

function buildBranch(
  start: number,
  count: number,
  branching: number,
  depth: number,
): ComplexTreeNode {
  if (count === 1) return { kind: "leaf", index: start };
  const childSize = count / branching;
  return {
    kind: "branch",
    depth,
    children: Array.from(
      { length: branching },
      (_, childIndex) =>
        buildBranch(start + childIndex * childSize, childSize, branching, depth + 1),
    ),
  };
}
