import { BitMatrix, SparseBitMatrix } from "../../packages/jsimd/src/bit-matrix/mod.ts";

using graph = BitMatrix.fromEdges(3, 3, [[0, 1], [1, 2]]);
using twoSteps = graph.multiply(graph);
using sparse = SparseBitMatrix.fromEdges(3, 3, [[0, 1], [1, 2]]);
document.body.textContent = `${twoSteps.row(0).toArray().join(",")}:${sparse.has(0, 1)}`;
