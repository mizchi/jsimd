# BinaryVectorIndex

A frozen Wasm-resident index for exhaustive Hamming search over equal-width binary signatures.

```ts
import { BinaryVectorIndex } from "@mizchi/jsimd/binary-vector-index";

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
Applications should rerank the returned candidates with their original vectors when recall matters.
Non-byte-aligned dimensions are preserved; unused high bits in the final query byte are ignored.

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
| Wasm SIMD      |           152.4 us |
| JS scalar      |         1,192.2 us |

The resident SIMD scan was 7.82x faster. Construction and final output copying are excluded; a
one-shot workload must include those costs. Binary signatures use 1/32 of the bytes of their source
Float32 vectors, but quantization can change nearest-neighbor quality.

```sh
pnpm bench:binary-vector-index
pnpm bench:record:binary-vector-index
pnpm bench:compare:binary-vector-index
```

The isolated Vite fixture emits one 0.21 kB Wasm asset (0.18 kB gzip) and a 6.26 kB JS wrapper (2.60
kB gzip). It emits no other entrypoint's Wasm. `kernels.wat` is the source; the stripped and
validated `kernels.wasm` remains Git-ignored.
