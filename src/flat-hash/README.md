# FlatHashSetU32 / FlatHashMapU32U32

Mutable Wasm-resident hash tables for unsigned 32-bit keys and values. Each probe compares a 16-byte
control group with `i8x16.eq` and `i8x16.bitmask`, then verifies only matching 7-bit fingerprints
against the key array.

```ts
import { FlatHashMapU32U32, FlatHashMapU64U32, FlatHashSetU32 } from "@mizchi/jsimd/flat-hash";

using selected = FlatHashSetU32.from([1, 10, 0xffff_ffff]);
selected.insert(100);
selected.has(10); // true
selected.delete(1); // true

const queryKeys = new Uint32Array([10, 11, 100]);
const present = new Uint8Array(queryKeys.length);
selected.lookupMany(queryKeys, present); // 2; present = [1, 0, 1]
const selectedKeys = new Uint32Array(selected.size);
selected.keysInto(selectedKeys);

using offsets = FlatHashMapU32U32.from([
  [10, 1_000],
  [20, 2_000],
]);
offsets.set(30, 3_000);

const values = new Uint32Array(queryKeys.length);
offsets.lookupMany(queryKeys, values, present);
const entryKeys = new Uint32Array(offsets.size);
const entryValues = new Uint32Array(offsets.size);
offsets.entriesInto(entryKeys, entryValues);

using wideIds = FlatHashMapU64U32.from([[0x1_0000_0000n, 42]]);
wideIds.get(0x1_0000_0000n); // 42
wideIds.lookupMany(bigUint64Queries, values, present);
```

`lookupMany` writes one presence byte per query and returns the hit count. Map lookup also writes
the corresponding values; missing positions are zeroed, so consult the presence output when zero is
a valid stored value. `insertMany` accepts `Uint32Array` inputs and performs all probing inside one
Wasm call.

`FlatHashMapU64U32` uses `bigint` for point keys and `BigUint64Array` for bulk keys. It preserves
the complete unsigned 64-bit domain and keeps `u32` values. This targets hashes, packed coordinates,
database IDs, and handles that cannot be represented losslessly as JS numbers.

The tables grow at a maximum 7/8 load and preserve deletions as tombstones. Set storage uses one
control byte and one four-byte key per slot. Map storage adds one four-byte value. `initialCapacity`
means slots, is rounded to a power of two, and has a minimum of 16.

Declare every owning table with `using`; scope exit returns its active and superseded growth blocks
to the allocator through `Symbol.dispose`. Repeated growth to the same capacity reaches a stable
allocator plateau, although Wasm linear memory itself does not shrink.

These types do not replace arbitrary-key JavaScript `Map` or `Set`. The useful case is a numeric
schema with batched lookup or insertion. Native collections remain faster for point operations that
cross the JS/Wasm boundary one key at a time.

## Design source

The control-byte layout follows the candidate-filtering idea in the
[Abseil Swiss Tables design notes](https://abseil.io/about/design/swisstables): one metadata byte
per slot, a 7-bit hash fingerprint, and a 16-lane comparison before full key checks. jsimd uses
aligned Wasm-v128 groups, a fixed `u32` avalanche hash, separate typed key/value arrays, and
explicit bulk APIs; it is not an API or implementation port of Abseil.

## Benchmark

Recorded with Vitest 4.1.11 / Node 24.12 / Apple M5. The lookup workload contains 262,144 stored
keys and 131,072 mixed hit/miss queries. Construction is excluded except in the rebuild rows.

| operation                             | FlatHash |  JS / sorted reference | relative result        |
| :------------------------------------ | -------: | ---------------------: | :--------------------- |
| set `lookupMany`, 131,072 queries     | 728.4 us |                4.86 ms | FlatHash 6.68x faster  |
| map `lookupMany`, 131,072 queries     | 846.2 us |                4.97 ms | FlatHash 5.87x faster  |
| set clear + 262,144 inserts           |  1.66 ms |               16.47 ms | FlatHash 9.92x faster  |
| map clear + 262,144 inserts           |  2.09 ms |               19.42 ms | FlatHash 9.28x faster  |
| set point `has`, 1,024 calls          |  12.5 us |                 7.7 us | JS Set 1.63x faster    |
| map point `get`, 1,024 calls          |  29.0 us |                 8.6 us | JS Map 3.37x faster    |
| sorted array search, 131,072 queries  |        — |               20.60 ms | FlatHash 28.29x faster |
| u64 map `lookupMany`, 131,072 queries |  1.59 ms | `Map<bigint>` 18.97 ms | FlatHash 11.96x faster |

Bulk speedups include copying query and result buffers across the boundary. Point results expose the
opposite boundary: the native builtins win when each query is a separate call. Rerun on the target
engine and data distribution before selecting a representation.

```sh
pnpm bench:flat-hash
pnpm bench:record:flat-hash
pnpm bench:compare:flat-hash
```

## Standalone build size

The isolated Vite fixture using u32 set and u64 map emits one 2.12 kB Wasm asset (0.95 kB gzip) and
a 10.89 kB minified JS wrapper (3.35 kB gzip). The JS size includes allocator and ownership code.
`just check` rejects accidental imports of other jsimd kernels.

See [`experiments/flat-hash`](../../experiments/flat-hash/README.md) for benchmark source and the
committed baseline.

Files:

- `mod.ts`: typed public contracts, growth, bulk boundary handling, and ownership
- `kernels.wat`: hashing, SIMD control-group probing, tombstones, bulk operations, and rehashing
- `kernels.d.wasm.ts`: typed Wasm module contract
- `kernels.wasm`: generated 2,129-byte binary; stripped, validated, and Git-ignored
