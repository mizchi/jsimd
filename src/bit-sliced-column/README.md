# BitSlicedColumnU8

A mostly-static Wasm-resident integer column optimized for repeated equality and range scans.
Instead of storing one byte per row, it stores one bitmap for each bit position:

```text
values:  3  4  5  6
bit 0:   1  0  1  0
bit 1:   1  0  0  1
bit 2:   0  1  1  1
valid:   1  1  1  1
```

One `v128` operation therefore evaluates the same bit of 128 rows. Equality intersects the required
positive and negative planes. Less-than scans from the most-significant plane while maintaining
`equal-prefix` and `already-less` masks. Nullability uses a separate validity bitmap and never
reserves a data value as a sentinel.

```ts
import { BitSlicedColumnU8, BitSliceMask } from "@mizchi/jsimd/bit-sliced-column";

const values = new Uint8Array([3, 4, 5, 6, 7, 12]);
const validity = new Uint8Array([1, 1, 0, 1, 1, 1]);
using column = BitSlicedColumnU8.from(values, 4, validity);
using selected = new BitSliceMask(column.length);

column.eq(7, selected);
selected.toIndices(); // [4]

column.between(4, 7, selected); // inclusive; null row 2 stays excluded
selected.toIndices(); // [1, 3, 4]
```

Selection masks remain in the same Wasm memory and can be composed without materializing row IDs:

```ts
using status = BitSlicedColumnU8.from(new Uint8Array([1, 0, 1, 1, 0, 1]), 1);
using range = new BitSliceMask(column.length);
using active = new BitSliceMask(column.length);

column.between(4, 12, range);
status.eq(1, active);
range.andAssign(active);
range.countOnes();
```

`BitSliceMask` is deliberately local to this entrypoint rather than `FixedBitSet`: independently
tree-shaken Wasm modules have distinct linear memories, and crossing between them would add a full
mask copy to every predicate. Masks support `andAssign`, `orAssign`, `differenceAssign`,
`countOnes`, and final `toIndices` materialization. Declare columns and masks with `using`.

## Design sources

The layout follows the bit-sliced index—an orthogonal bit-by-bit view of a column—described by
[O'Neil and Quass, “Improved Query Performance with Variant Indexes”](https://doi.org/10.1145/253260.253268).
The scan organization is also related to
[Li and Patel, “BitWeaving: Fast Scans for Main Memory Data Processing”](https://www.microsoft.com/en-us/research/?p=215048),
which evaluates bit-parallel column layouts and distinguishes vertical and horizontal variants. This
implementation is a Wasm-v128-specific design, not a source-compatible port of either system.

## Performance characteristics

Recorded with Vitest 4.1.11 / Node 24.12 / Apple M5 over 4,194,304 rows. The column is five bits
wide. Both paths produce a packed result mask and count its bits; construction is excluded.

| operation                 | Bit-sliced SIMD | scalar `Uint8Array` | speedup |
| :------------------------ | --------------: | ------------------: | ------: |
| equality                  |        106.6 us |             2.41 ms |   22.6x |
| less-than                 |        137.0 us |             4.05 ms |   29.6x |
| inclusive between         |        239.1 us |             4.69 ms |   19.6x |
| two predicates + mask AND |        281.2 us |             4.95 ms |   17.6x |

This is not always faster than JavaScript. It targets large, repeatedly scanned, mostly-static
columns. Construction transposes every input value, point extraction visits every bit plane, and
small scans can be dominated by the Wasm call. Logical storage is `(bitWidth + 1) / 8` bytes per row
including validity: 0.75 bytes at five bits, but 1.125 bytes at eight bits—larger than a raw
`Uint8Array`. The result mask adds 0.125 bytes per row. Updates and full value materialization are
intentionally absent from this first API.

```sh
pnpm bench:bit-sliced-column
pnpm bench:record:bit-sliced-column
pnpm bench:compare:bit-sliced-column
```

## Standalone build size

The Vite production fixture imports only `@mizchi/jsimd/bit-sliced-column`:

| asset                             |     raw |    gzip |
| :-------------------------------- | ------: | ------: |
| Wasm                              |   898 B |   430 B |
| minified JS wrapper and allocator | 7.83 kB | 3.00 kB |

`just check` requires exactly one Wasm asset and rejects exports from every other jsimd kernel.

See [`experiments/bit-sliced-column`](../../experiments/bit-sliced-column/README.md) for benchmark
source and the committed baseline.

Files:

- `mod.ts`: column construction, nullable contract, resident mask API, and ownership
- `kernels.wat`: bit-sliced predicates, mask composition, and SIMD popcount
- `kernels.d.wasm.ts`: typed Wasm module contract
- `kernels.wasm`: generated 898-byte binary; stripped, validated, and Git-ignored
