# WaveletMatrixUint16

An immutable 16-level wavelet matrix for unsigned 16-bit values. It targets UTF-16 code units,
compact category IDs, and other frozen sequences whose domain is wider than bytes but does not need
the 32 levels of `WaveletMatrixUint32`.

```ts
import { WaveletMatrixUint16 } from "@mizchi/jsimd/wavelet-matrix-uint16";

const codeUnits = Uint16Array.from("banana", (character) => character.charCodeAt(0));
using text = WaveletMatrixUint16.from(codeUnits);

text.rank("a".charCodeAt(0), text.length); // 3
text.rangeFreq(0, text.length, 97, 111); // 5 values in [97, 111)
text.quantile(0, text.length, 0); // 97
```

The API also provides `access`, `select`, `predecessor`, `accessMany`, `rankMany`, and
`quantileMany`. Values and batch results use `Uint16Array`; positions and counts use `Uint32Array`.
The range upper bound may be `65536`, while stored values must be in `[0, 65536)`.

Declare the matrix with `using`. Construction copies the source into Wasm memory, and scope exit
returns all resident allocations to the module-local reuse pool. `serialize()` and
`WaveletMatrixUint16.fromSnapshot()` persist and restore the frozen index without rebuilding it.

## Layout

Each of the 16 levels stores one bit per value and a cumulative rank every 512 bits. Logical
resident size approaches 2.125 bytes per value: 2 bytes of level bits and 0.125 bytes of rank
prefixes, plus padding and 64 bytes of zero boundaries. Construction makes 16 stable-partition
passes and uses temporary `Uint32` buffers, so this is a build-once/query-many structure rather than
a replacement for a `Uint16Array`.

## Performance and trade-offs

Recorded with Vitest 4.1.11 / Node 24 / Apple M5 over 262,144 values:

| operation            | Uint16 matrix | comparison               | result       |
| :------------------- | ------------: | :----------------------- | :----------- |
| `rankMany` × 4,096   |     0.6025 ms | Uint32 matrix: 1.3848 ms | 2.30x faster |
| `rankMany` × 4,096   |     0.6025 ms | JS positions: 0.0417 ms  | 14.4x slower |
| `accessMany` × 4,096 |     0.8041 ms | direct access: 0.0120 ms | 67x slower   |
| `quantileMany` × 64  |     0.0090 ms | Uint32 matrix: 0.0222 ms | 2.47x faster |
| `quantileMany` × 64  |     0.0090 ms | copy-sort JS: 2.9553 ms  | 329x faster  |

Use a `Uint16Array` for direct access. Use a value-to-sorted-positions index when exact rank is the
only required query. This structure earns its cost when one compact frozen index must also answer
range frequencies, quantiles, predecessor, and select. The 16-level specialization is consistently
faster than routing the same values through `WaveletMatrixUint32`, but construction and snapshot
size remain roughly proportional to the number of levels.

```sh
pnpm bench:wavelet-matrix-uint16
pnpm bench:record:wavelet-matrix-uint16
pnpm bench:compare:wavelet-matrix-uint16
```

The benchmark source and committed baseline are under
[`experiments/wavelet-matrix-uint16`](../../experiments/wavelet-matrix-uint16).

## Standalone build size

The isolated Vite 8.2 production fixture emits 11.80 kB minified JavaScript (4.26 kB gzip) and one
2.10 kB Wasm asset (0.97 kB gzip). It emits no other entrypoint's Wasm.

The binary layout follows the wavelet matrix family and uses the same 512-bit rank blocks as this
package's Uint8 and Uint32 variants. See
[Faster Wavelet Tree Queries](https://arxiv.org/html/2302.09239v2) and the
[JSAI succinct-data-structure overview](https://www.ai-gakkai.or.jp/resource/my-bookmark/my-bookmark_vol26-no6/).

Files:

- `mod.ts`: TypeScript API, validation, snapshots, and ownership
- `kernels.wat`: 16-level build and query kernels using SIMD rank scans
- `kernels.d.wasm.ts`: typed Wasm contract
- `kernels.wasm`: generated, stripped, validated, and Git-ignored
