import { BitMatrix, SparseBitMatrix } from "../bit-matrix/mod.ts";
import { assertEquals } from "../../test/assert.ts";

Deno.test("BitMatrix stores dense rows and exposes non-owning row views", () => {
  using matrix = new BitMatrix(3, 130);
  matrix.set(0, 0).set(0, 129).set(2, 64);
  assertEquals(matrix.has(0, 0), true, "first bit");
  assertEquals(matrix.has(0, 129), true, "tail bit");
  assertEquals(matrix.has(1, 0), false, "empty row");
  assertEquals(matrix.row(0).countOnes(), 2, "row count");
  assertEquals(matrix.row(0).toArray().join(","), "0,129", "row values");
  matrix.set(0, 129, false);
  assertEquals(matrix.row(0).toArray().join(","), "0", "row mutation");
});

Deno.test("BitMatrix transposes non-aligned rectangular matrices", () => {
  using matrix = BitMatrix.fromEdges(3, 5, [[0, 1], [0, 4], [2, 0], [2, 4]]);
  using transposed = matrix.transpose();
  assertEquals(transposed.rows, 5, "transposed rows");
  assertEquals(transposed.columns, 3, "transposed columns");
  assertEquals(transposed.row(0).toArray().join(","), "2", "column zero");
  assertEquals(transposed.row(4).toArray().join(","), "0,2", "column four");
});

Deno.test("BitMatrix multiplies over the Boolean semiring", () => {
  using left = BitMatrix.fromEdges(3, 4, [[0, 0], [0, 2], [1, 1], [2, 3]]);
  using right = BitMatrix.fromEdges(4, 3, [[0, 1], [1, 0], [2, 1], [2, 2], [3, 2]]);
  using product = left.multiply(right);
  assertEquals(product.row(0).toArray().join(","), "1,2", "product row zero");
  assertEquals(product.row(1).toArray().join(","), "0", "product row one");
  assertEquals(product.row(2).toArray().join(","), "2", "product row two");
});

Deno.test("BitMatrix multiply matches scalar rectangular matrices across SIMD tails", () => {
  let state = 0x55aa_1234;
  for (const [rows, shared, columns] of [[1, 1, 1], [3, 33, 5], [7, 129, 11]]) {
    const leftEdges: Array<readonly [number, number]> = [];
    const rightEdges: Array<readonly [number, number]> = [];
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < shared; column++) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        if ((state & 15) === 0) leftEdges.push([row, column]);
      }
    }
    for (let row = 0; row < shared; row++) {
      for (let column = 0; column < columns; column++) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        if ((state & 15) === 0) rightEdges.push([row, column]);
      }
    }
    using left = BitMatrix.fromEdges(rows, shared, leftEdges);
    using right = BitMatrix.fromEdges(shared, columns, rightEdges);
    using product = left.multiply(right);
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        let expected = false;
        for (let inner = 0; inner < shared; inner++) {
          if (left.has(row, inner) && right.has(inner, column)) {
            expected = true;
            break;
          }
        }
        assertEquals(product.has(row, column), expected, `${rows}x${shared}x${columns}`);
      }
    }
  }
});

Deno.test("BitMatrix using lifecycle returns storage and invalidates views", () => {
  const before = BitMatrix.allocatorStats();
  let view: ReturnType<BitMatrix["row"]>;
  {
    using matrix = BitMatrix.fromEdges(128, 128, [[0, 0], [127, 127]]);
    view = matrix.row(127);
    assertEquals(view.countOnes(), 1, "live view");
  }
  let disposed = false;
  try {
    view!.countOnes();
  } catch (error) {
    disposed = error instanceof Error && error.message.includes("disposed");
  }
  assertEquals(disposed, true, "view follows parent lifetime");
  const after = BitMatrix.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});

Deno.test("SparseBitMatrix canonicalizes CSR rows and transposes", () => {
  using matrix = SparseBitMatrix.fromEdges(4, 5, [
    [0, 3],
    [0, 1],
    [0, 3],
    [2, 4],
    [3, 0],
  ]);
  assertEquals(matrix.edgeCount, 4, "deduplicated edges");
  assertEquals(matrix.row(0).toArray().join(","), "1,3", "sorted row");
  assertEquals(matrix.row(1).countOnes(), 0, "empty row");
  assertEquals(matrix.has(2, 4), true, "present edge");
  assertEquals(matrix.has(2, 3), false, "missing edge");
  using transposed = matrix.transpose();
  assertEquals(transposed.rows, 5, "transpose rows");
  assertEquals(transposed.columns, 4, "transpose columns");
  assertEquals(transposed.row(3).toArray().join(","), "0", "transpose edge");
});

Deno.test("SparseBitMatrix using lifecycle returns CSR storage", () => {
  const before = SparseBitMatrix.allocatorStats();
  for (let iteration = 0; iteration < 1_000; iteration++) {
    using graph = SparseBitMatrix.fromEdges(
      1024,
      1024,
      Array.from(
        { length: 4096 },
        (_, index) => [index & 1023, (Math.imul(index, 17) + 1) & 1023] as const,
      ),
    );
    assertEquals(graph.countRowOnes(0) > 0, true, "live graph");
  }
  const after = SparseBitMatrix.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});

Deno.test("matrix rows write positions into caller-owned outputs", () => {
  using dense = BitMatrix.fromEdges(2, 10, [[0, 1], [0, 4], [0, 9]]);
  const denseOutput = new Uint32Array(4).fill(99);
  assertEquals(dense.row(0).positionsInto(denseOutput), 3, "dense row count");
  assertEquals(denseOutput.join(","), "1,4,9,99", "dense row output");

  using sparse = SparseBitMatrix.fromEdges(2, 10, [[1, 2], [1, 8], [1, 2]]);
  const sparseOutput = new Uint32Array(3).fill(99);
  assertEquals(sparse.row(1).positionsInto(sparseOutput), 2, "sparse row count");
  assertEquals(sparseOutput.join(","), "2,8,99", "sparse row output");
});
