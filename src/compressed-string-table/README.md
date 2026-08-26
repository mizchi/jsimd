# CompressedStringTable

A frozen table for byte strings with block-local front coding. Every 16 entries share one anchor;
each other entry stores an anchor-prefix length and its remaining suffix. Input order and IDs are
preserved.

```ts
import { CompressedStringTable } from "@mizchi/jsimd/compressed-string-table";

using paths = CompressedStringTable.fromUtf8([
  "src/components/button.ts",
  "src/components/button.test.ts",
]);

new TextDecoder().decode(paths.get(1));
```

`equalsMany(ids, queries, offsets)` compares anchor prefixes and suffixes directly in resident
memory with 16-byte SIMD blocks; it does not decode strings. `get` and `decodeInto` reconstruct a
value and copy it back to JavaScript.

`serialize()` keeps IDs, front-coding metadata, and the suffix arena. Restore with
`CompressedStringTable.fromSnapshot(bytes)`; the loader validates every segment against its anchor
and arena before allocating Wasm memory. The recorded 16,384-path snapshot was 320,822 bytes and
restored about 100x faster than rebuilding. Persisting poorly clustered strings retains their same
metadata overhead, so a snapshot does not improve compression.

## Performance, compression, and trade-offs

The recorded corpus contains 65,536 generated source paths. Front coding used 1,313,706 bytes for
4,242,080 raw bytes (31.0%). Compression depends on ordering and prefix distribution. Metadata costs
12 bytes per entry plus four bytes per 16-entry block, so short or unrelated strings can become
larger than their input.

On Apple M5 / Node 24.12 / Vitest 4.1.11, for 4,096 mixed equality/materialization queries:

| operation                   |      time | interpretation                                 |
| :-------------------------- | --------: | :--------------------------------------------- |
| `equalsMany`                | 0.0414 ms | 2.00x faster than scalar `Uint8Array` equality |
| pre-decoded string equality | 0.0101 ms | 4.12x faster than `equalsMany`                 |
| front-coded `get`           | 1.2718 ms | 12.3x slower than `Uint8Array#slice`           |

Use this type for frozen, prefix-clustered binary strings when space and equality scans matter more
than frequent materialization. Native strings remain better when values are already decoded, and an
array of bytes remains better for random `get`.

## Standalone build size

The isolated Vite 8.2 production fixture emits 11.75 kB minified JavaScript (4.18 kB gzip) and one
0.66 kB Wasm asset (0.34 kB gzip).

The design is deliberately simpler than FSST/OnPair and keeps independently decodable block-local
entries. Sources: [OnPair](https://arxiv.org/html/2508.02280v1), the
[JSAI succinct-data-structure overview](https://www.ai-gakkai.or.jp/resource/my-bookmark/my-bookmark_vol26-no6/),
and the
[benchmark source](../../experiments/compressed-string-table/compressed-string-table.bench.ts).
Snapshot format and transport measurements are in
[`experiments/snapshots`](../../experiments/snapshots/README.md).
