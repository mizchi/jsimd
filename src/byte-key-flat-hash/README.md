# ByteKeyFlatHashMapU32

A mutable Wasm-resident flat hash map from arbitrary byte strings to unsigned 32-bit values. It is
intended for repeated bulk lookup of already encoded keys, not as a general replacement for
JavaScript `Map`.

```ts
import { ByteKeyFlatHashMapU32 } from "@mizchi/jsimd/byte-key-flat-hash";

const encoder = new TextEncoder();
using symbols = new ByteKeyFlatHashMapU32();
symbols.set(encoder.encode("parse"), 1);
symbols.set(encoder.encode("emit"), 2);

const queries = encoder.encode("parsemissingemit");
const offsets = Uint32Array.of(0, 5, 12, 16);
const values = new Uint32Array(3);
const present = new Uint8Array(3);
symbols.lookupMany(queries, offsets, values, present);
// values  = [1, 0, 2]
// present = [1, 0, 1]
```

`insertMany(bytes, offsets, values)` and `lookupMany(bytes, offsets, values, present)` encode key
`i` as `bytes.subarray(offsets[i], offsets[i + 1])`. Empty and binary keys are supported. The map
owns Wasm allocations and should be declared with `using`.

## Layout and trade-offs

The table uses 16-byte SwissTable-style control groups. A 7-bit fingerprint selects candidates with
`i8x16.eq` and `i8x16.bitmask`; candidate lengths are checked before complete keys are verified in
16-byte SIMD blocks with a scalar tail. Slot metadata points into an append-only byte arena.

This is useful for compiler symbols, encoded paths, protocol fields, or binary identifiers when many
queries are concatenated into one call. It is not succinct: control bytes, offsets, lengths, and
values add 13 bytes per table slot before allocator rounding and key payload.

Single operations copy one key across the JS/Wasm boundary and are much slower than native `Map`.
Bulk duplicate insertion and deletion leave dead arena bytes. `arenaBytes` exposes appended payload
size; `clear()` resets it, while long-lived maps with heavy churn should be rebuilt.

The control layout follows [Abseil Swiss Tables](https://abseil.io/about/design/swisstables).

## Benchmark

Recorded with Vitest 4.1.11 / Node 24.12 / Apple M5. The table contains 131,072 variable-length
8–40-byte keys. Bulk performs 65,536 half-hit queries; point lookup performs 4,096 queries. Native
binary keys are precomputed hexadecimal strings, so conversion and construction are excluded.

| lookup workload       | byte-key Wasm | `Map<string, number>` | result                  |
| :-------------------- | ------------: | --------------------: | :---------------------- |
| 65,536-key bulk       |       1.41 ms |               2.82 ms | Wasm 2.00x faster       |
| 4,096 individual gets |       0.79 ms |               0.06 ms | native Map 12.5x faster |

```sh
pnpm bench:byte-key-flat-hash
pnpm bench:record:byte-key-flat-hash
pnpm bench:compare:byte-key-flat-hash
```

## Standalone build size

The isolated Vite fixture emits a 9.07 kB minified JavaScript wrapper (3.10 kB gzip) and one 1.26 kB
Wasm asset (0.73 kB gzip). No other `jsimd` Wasm entrypoint is included.

See [`experiments/byte-key-flat-hash`](../../experiments/byte-key-flat-hash/README.md) for the
benchmark source and committed baseline.
