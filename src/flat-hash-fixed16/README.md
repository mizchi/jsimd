# FlatHashMapFixed16U32 / FlatHashSetFixed16

Mutable Wasm-resident SwissTable-style collections for fixed 16-byte keys. A control-group
fingerprint selects candidate lanes, then each candidate is verified with a complete `v128` key
comparison.

```ts
import { FlatHashMapFixed16U32, FlatHashSetFixed16 } from "@mizchi/jsimd/flat-hash-fixed16";

const id = new Uint8Array(16);
crypto.getRandomValues(id);

using map = new FlatHashMapFixed16U32();
map.set(id, 42);
map.get(id); // 42

using set = FlatHashSetFixed16.from([id]);
set.has(id); // true

// Keys are concatenated without per-key objects for bulk operations.
const queries = new Uint8Array(16 * 2);
queries.set(id, 0);
const values = new Uint32Array(2);
const present = new Uint8Array(2);
map.lookupMany(queries, values, present);

const storedKeys = new Uint8Array(map.size * 16);
const storedValues = new Uint32Array(map.size);
map.entriesInto(storedKeys, storedValues);
```

Keys must contain exactly 16 bytes. Bulk key arrays contain consecutive keys and therefore have a
length divisible by 16. Values cover the complete unsigned 32-bit range. Both collections own Wasm
storage and must be declared with `using`.

Good fits include UUIDs, content hashes, truncated digests, binary entity IDs, and fixed-size
compiler keys. Native `Map` remains preferable for arbitrary JavaScript object keys and small or
point-heavy workloads. Individual operations copy one key across the boundary; `lookupMany()` and
`insertMany()` amortize that cost.

## Design source

The control-byte and 7-bit fingerprint layout follows
[Abseil Swiss Tables](https://abseil.io/about/design/swisstables). Wasm's 128-bit SIMD width also
allows a complete fixed key to be compared with one load and one `i8x16.eq`. Hashing, probe
sequence, fingerprint selection, full-key validation, and value access remain fused inside Wasm.

## Benchmark

Recorded with Vitest 4.1.11 / Node 24.12 / Apple M5. A 131,072-key table receives 65,536 half-hit
queries. Native keys are precomputed hexadecimal strings, so conversion is excluded.

| lookup workload | Fixed16 Wasm | native string collection | result            |
| :-------------- | -----------: | -----------------------: | :---------------- |
| map             |      1.41 ms |                 39.30 ms | Wasm 27.9x faster |
| set             |      1.34 ms |                 34.24 ms | Wasm 25.6x faster |

The comparison is specifically for binary 16-byte identity. It does not imply an advantage over
`Map<number, V>`, whose numeric key path is substantially cheaper.

```sh
pnpm bench:flat-hash-fixed16
pnpm bench:record:flat-hash-fixed16
pnpm bench:compare:flat-hash-fixed16
```

## Standalone build size

The isolated Vite fixture emits an 8.64 kB minified JavaScript wrapper (3.02 kB gzip) and one 0.97
kB Wasm asset (0.62 kB gzip). It emits neither the generic `flat-hash` nor fingerprint-only Wasm.

See [`experiments/flat-hash-fixed16`](../../experiments/flat-hash-fixed16/README.md) for benchmark
source and the committed baseline.
