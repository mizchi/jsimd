# StaticMphfBytes / FrozenByteMapU32 (rejected prototype)

This prototype is not exported by the npm or Deno package. It remains in the repository only as
rejection evidence: the best equivalent JavaScript representation won both lookup and construction.

An immutable minimal perfect hash for a key set known at construction time. Keys are arbitrary
bytes: empty keys, embedded NUL bytes, and long common prefixes are supported. Exact membership is
verified against a frozen byte arena, so unknown keys never become false positives.

`StaticMphfBytesBuilder` separates mutable construction from the frozen query layout.
`StaticMphfBytes.lookupMany(bytes, offsets, output)` and `FrozenByteMapU32.lookupMany(...)` keep the
hashing, displacement lookup, and exact SIMD comparison behind one JS/Wasm boundary. Returned IDs
are stable only for that frozen instance; they are dense `[0, length)` slots, not insertion order.

## Layout and trade-offs

Keys are assigned with bucket displacements in the style of compress-hash-displace perfect hashes.
Each slot stores its arena offset and length. The lookup kernel hashes the query twice, computes one
candidate slot, then compares complete 16-byte blocks with `i8x16.eq` and `i8x16.bitmask` before a
scalar tail.

This representation is useful when callers already have binary queries. JavaScript has no builtin
collection that compares `Uint8Array` keys by value: `Map<Uint8Array, ...>` compares object
identity. A pre-encoded string key is still the faster choice when that representation already
exists.

On Apple M5 / Node 24.12 / Vitest 4.1.11, over 65,536 variable-length keys and 4,096 mixed queries:

| operation                     |    result | interpretation                                                     |
| :---------------------------- | --------: | :----------------------------------------------------------------- |
| `lookupMany`                  | 0.1209 ms | 13.5x faster than encoding each byte query to hex before `Set.has` |
| pre-encoded `Set<string>.has` | 0.0534 ms | 2.26x faster than `lookupMany`                                     |
| repeated single `lookup`      | 0.8656 ms | 16.2x slower than the pre-encoded `Set` loop                       |
| build 16,384 keys             |  31.86 ms | 94.8x slower than building the pre-encoded `Set`                   |

Construction and point lookup are deliberately not presented as wins. The exact arena also means
this is not key-free MPHF storage; table metadata costs about nine bytes per key in addition to the
original key bytes, and `FrozenByteMapU32` adds four value bytes per key.

## Rejected bundle cost

The experimental Vite 8.2 fixture emits 10.50 kB minified JavaScript (3.95 kB gzip) and one 0.84 kB
Wasm asset (0.53 kB gzip). This cost is not part of the published package surface.

Sources: [PtrHash and modern MPHF design](https://arxiv.org/html/2502.15539v1),
[Wasm SIMD](https://github.com/WebAssembly/spec/blob/main/proposals/simd/SIMD.md), and the
[benchmark source](../static-mphf-bytes.bench.ts).
