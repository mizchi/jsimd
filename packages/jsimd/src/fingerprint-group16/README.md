# FingerprintGroup16

A Wasm-resident 16-byte SwissTable control group. Fingerprint, empty, and deleted probes use
`i8x16.eq` followed by `i8x16.bitmask` and return a 16-bit lane mask.

```ts
import { FingerprintGroup16, FingerprintTable16 } from "@mizchi/jsimd/fingerprint-group16";

using group = FingerprintGroup16.from(
  Uint8Array.of(7, 1, 7, 0x80, 0xfe, 7, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12),
);

group.matchMask(7); // lanes 0, 2, 5, and 10
group.emptyMask(); // lane 3
group.deletedMask(); // lane 4
group.firstMatch(7); // 0

const fingerprints = Uint8Array.of(7, 3, 127);
const masks = new Uint16Array(fingerprints.length);
group.matchMany(fingerprints, masks);

using table = new FingerprintTable16(65_536);
table.setControl(18, 7);

const hashes = Uint32Array.of((7 << 25) | 18);
const groups = new Uint32Array(1);
const tableMatches = new Uint16Array(1);
const empty = new Uint16Array(1);
const deleted = new Uint16Array(1);
table.probeMany(hashes, groups, tableMatches, empty, deleted);
```

Fingerprints occupy `0x00..0x7f`; `0x80` means empty and `0xfe` means deleted. The group owns 16
bytes of Wasm memory and must be declared with `using`.

This is a control-group primitive, not a complete hash table. A mask only identifies candidate
lanes; callers must still compare complete keys. Single probes usually should remain in JavaScript
or inside a larger Wasm hash kernel. `matchMany()` exists to amortize the boundary.

## Design source

The layout follows [Abseil Swiss Tables](https://abseil.io/about/design/swisstables): one metadata
byte per slot and a 7-bit hash fingerprint for parallel candidate selection. The 16-lane width is a
direct match for fixed-width Wasm SIMD.

## Benchmark

Recorded with Vitest 4.1.11 / Node 24.12 / Apple M5, with one resident group and reusable output.

| operation                   |     Wasm | JavaScript | result            |
| :-------------------------- | -------: | ---------: | :---------------- |
| 1,024 individual probes     |  6.17 us |    5.08 us | JS 1.22x faster   |
| 131,072 probes in one batch | 485.5 us |   775.0 us | Wasm 1.60x faster |
| 131,072 multi-group probes  | 218.6 us |   1.073 ms | Wasm 4.91x faster |

The batch measurement includes copying query fingerprints into Wasm and masks back out. Do not use
this entrypoint to replace a 16-iteration JS loop for only one or a few probes.

```sh
pnpm bench:fingerprint-group16
pnpm bench:record:fingerprint-group16
pnpm bench:compare:fingerprint-group16
```

## Standalone build size

The isolated Vite fixture emits a 5.52 kB minified JavaScript wrapper (2.35 kB gzip) and one 0.39 kB
Wasm asset (0.30 kB gzip). It does not emit the complete FlatHash Wasm.

See [`experiments/fingerprint-group16`](../../experiments/fingerprint-group16/README.md) for the
benchmark source and committed baseline.
