# @mizchi/jsimd/packed-delta-uint32-list experiment

Compares the frozen Stream VByte representation with an uncompressed sorted `Uint32Array`.
Construction is excluded. Outputs are reused so the measurements focus on resident decode, lookup,
and intersection behavior.

```ts
import { PackedDeltaUint32List } from "@mizchi/jsimd/packed-delta-uint32-list";

using left = PackedDeltaUint32List.from([1, 3, 9, 100]);
using right = PackedDeltaUint32List.from([3, 10, 100]);
const output = new Uint32Array(3);
const count = left.intersectInto(right, output);
```

Recorded with Vitest 4.1.11 / Node 24.12 / Apple M5:

| workload / operation                  | PackedDelta | `Uint32Array` |
| :------------------------------------ | ----------: | ------------: |
| small deltas / full decode or copy    |    371.9 us |       23.7 us |
| variable deltas / full decode or copy |    399.1 us |       23.3 us |
| small deltas / 1,024 lower bounds     |    162.3 us |       55.9 us |
| variable deltas / 1,024 lower bounds  |    151.6 us |       45.4 us |
| two postings / reusable intersection  |    957.6 us |       1.34 ms |

Both generated datasets fit in one byte per delta. The encoded controls, data, and 128-value
checkpoints total 344,072 bytes for 262,144 values: 1.31 bytes/value versus 4 bytes/value for the
raw payload. The benchmark does not include allocator size-class padding.

```sh
pnpm bench:packed-delta-uint32-list
pnpm bench:record:packed-delta-uint32-list
pnpm bench:compare:packed-delta-uint32-list
```

The committed baseline is runtime-specific. In particular, full decoding pays for both decompression
and a Wasm-to-JS output copy, while `Uint32Array#set` is a highly optimized native copy. The
intersection kernel compares decoded four-value groups in Wasm and crosses the boundary once.
