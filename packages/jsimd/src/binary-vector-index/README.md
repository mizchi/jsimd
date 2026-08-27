# BinaryVectorIndex

A frozen Wasm-resident index for exhaustive Hamming search over equal-width binary signatures.

```ts
import {
  BinaryVectorIndex,
  BinaryVectorIndexWithRerank,
  PdxFloat32Index,
} from "@mizchi/jsimd/binary-vector-index";

using index = BinaryVectorIndex.fromSignatures([
  new Uint8Array([0x00, 0x00]),
  new Uint8Array([0xff, 0x00]),
  new Uint8Array([0xff, 0xff]),
]);
const distances = new Uint32Array(index.length);
index.distanceMany(new Uint8Array([0, 0]), distances); // [0, 8, 16]

const ids = new Uint32Array(2);
const nearestDistances = new Uint32Array(2);
index.topK(new Uint8Array([0, 0]), 2, ids, nearestDistances);
```

`fromFloat32(values, count, dimensions)` also produces one bit per dimension using `value > 0`. This
is sign quantization: Hamming order is only an approximation of the original Float32 metric.
Applications can use `BinaryVectorIndexWithRerank` to retain original vectors in a PDX layout and
rerank a caller-selected candidate count when recall matters. Non-byte-aligned dimensions are
preserved; unused high bits in the final query byte are ignored.

```ts
using index = BinaryVectorIndexWithRerank.fromFloat32(vectors, count, dimensions);
const ids = new Uint32Array(10);
const exactSquaredL2 = new Float32Array(10);
index.topK(query, 10, 100, ids, exactSquaredL2);
```

`PdxFloat32Index` remains public because its four-vector layout supports `distanceSelected` for
reranking sparse candidate IDs. For repeated exhaustive scans, prefer
[`BlockedVectorArray`](../blocked-vector-array/README.md), whose 64-vector PDX blocks measured 1.84x
faster in the shared 16,384 × 64 workload. Bind all owning types with `using`.

`BinaryVectorIndex.serialize()` preserves row padding and non-byte-aligned logical dimensions;
restore with `BinaryVectorIndex.fromSnapshot(bytes)`. The loader rejects non-zero padding or bits
outside the declared dimensions before allocation. An 8,192 x 256-bit snapshot was 262,176 bytes and
restored about 205x faster than re-quantizing Float32 input. Snapshots currently cover the binary
index itself, not `PdxFloat32Index` or the combined reranking wrapper.

The hot loop follows the binary-candidate stage used by systems such as
[QuIVer](https://arxiv.org/html/2605.02171v3): XOR followed by population count. This implementation
is deliberately smaller in scope—it performs an exact exhaustive Hamming scan and does not include
QuIVer's indexing or recall strategy. The available 128-bit operations and JavaScript boundary
constraints are defined by the
[WebAssembly SIMD proposal](https://github.com/WebAssembly/spec/blob/main/proposals/simd/SIMD.md).

## Layout and performance

Rows are padded independently to 16 bytes and kept in Wasm memory. `distanceMany` crosses the
boundary once, then applies `v128.xor`, `i8x16.popcnt`, and horizontal sums to every row. Logical
`encodedBytes` excludes alignment padding. `topK` currently materializes every distance and sorts
IDs in JavaScript, so prefer `distanceMany` when a downstream stage already owns selection.

Vitest 4.1.11 / Node 24 / Apple M5, 65,536 signatures of 256 bits:

| implementation | full distance scan |
| :------------- | -----------------: |
| Wasm SIMD      |           203.0 us |
| JS scalar      |         1,983.8 us |

The resident SIMD scan was 9.77x faster. Construction and final output copying are excluded; a
one-shot workload must include those costs. Binary signatures use 1/32 of the bytes of their source
Float32 vectors, but quantization can change nearest-neighbor quality.

Exact L2 over 16,384 vectors × 64 dimensions took 0.156 ms with PDX versus 1.007 ms for the scalar
`Float32Array` loop (6.46x faster). Reranking is not exact over the full collection if the binary
stage excludes a true neighbor. Larger `candidateCount` improves recall at proportional cost.

```sh
pnpm bench:binary-vector-index
pnpm bench:record:binary-vector-index
pnpm bench:compare:binary-vector-index
```

The isolated Vite fixture using binary and PDX scans emits one 0.85 kB Wasm asset (0.43 kB gzip) and
an 11.74 kB minified JS wrapper (4.17 kB gzip). It emits no other entrypoint's Wasm. `kernels.wat`
is the source; the stripped and validated `kernels.wasm` remains Git-ignored.

Cross-structure snapshot and transport results are in
[`experiments/snapshots`](../../experiments/snapshots/README.md).
