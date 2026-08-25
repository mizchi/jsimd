import { BitMatrix } from "../../src/bit-matrix/mod.ts";

using graph = BitMatrix.fromEdges(3, 3, [[0, 1], [1, 2]]);
using twoSteps = graph.multiply(graph);
document.body.textContent = twoSteps.row(0).toArray().join(",");
