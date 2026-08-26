# FmIndexBytes

A frozen full-text index over arbitrary bytes. Backward search counts overlapping occurrences in
time proportional to pattern length rather than text length. A suffix-array sample every 32 text
positions supports `locate` and `locateMany` without retaining the full suffix array.

```ts
import { FmIndexBytes } from "@mizchi/jsimd/fm-index-bytes";

const encoder = new TextEncoder();
using index = FmIndexBytes.from(encoder.encode("banana"));

index.count(encoder.encode("ana")); // 2
Array.from(index.locate(encoder.encode("ana"))).sort(); // [1, 3]
```

`countMany(patterns, offsets)` is the primary API. `locateMany` first materializes occurrence counts
and then allocates all positions; use `countMany` first when the result cardinality may be large.
Located positions are in suffix-array row order, not text order. The empty pattern has `length + 1`
matches, including the suffix at the end of the text.

`serialize()` persists the complete BWT, rank metadata, cumulative counts, and suffix-array sample.
`FmIndexBytes.fromSnapshot(bytes)` validates the versioned envelope and copies that resident state
without rebuilding or retaining the source text. On the 8,192-byte snapshot benchmark, restore took
0.003 ms versus 3.897 ms to rebuild; storage I/O can dominate this in practice.

## Layout

Construction produces a BWT, an eight-level byte wavelet matrix, cumulative symbol counts, and a
sampled suffix array. A sentinel row is tracked separately, so all 256 byte values—including NUL—
remain available while the rank layer stays at eight levels. Sample membership uses a bitvector,
rank index, and one `u32` per 32 text positions rather than a dense row-to-position table.

On the recorded 32,768-byte corpus the resident index was 52,960 bytes, or 1.62 bytes per input
byte. This is an index overhead, not text compression; the original text can be discarded if only
count/locate queries are needed.

## Performance and trade-offs

On Apple M5 / Node 24.12 / Vitest 4.1.11, counting 512 eight-byte patterns over 32,768 bytes:

| implementation                    |       time | relative to FM |
| :-------------------------------- | ---------: | -------------: |
| `FmIndexBytes.countMany`          |  0.4348 ms |             1x |
| overlapping `String#indexOf` loop |  2.9848 ms |   6.86x slower |
| scalar `Uint8Array` scan          | 32.9361 ms |   75.8x slower |

The same batch contained 233,657 positions. `locateMany` materialized them in 324.8 ms, illustrating
why callers should count and cap results before locating. Building an 8,192-byte index took 3.48 ms.
Construction uses a JavaScript prefix-doubling suffix array and sorting, so large one-shot texts can
cost much more than direct search. Short texts, few patterns, frequent updates, and workloads
needing text-ordered results favor native strings or another index.

## Standalone build size

The isolated Vite 8.2 production fixture emits 13.34 kB minified JavaScript (4.95 kB gzip) and one
2.91 kB Wasm asset (1.31 kB gzip).

Sources: the [FM-index authors' project page](https://people.unipmn.it/manzini/fmindex/), the
[JSAI succinct-data-structure overview](https://www.ai-gakkai.or.jp/resource/my-bookmark/my-bookmark_vol26-no6/),
and the [benchmark source](../../experiments/fm-index-bytes/fm-index-bytes.bench.ts).
Cross-structure snapshot measurements are in
[`experiments/snapshots`](../../experiments/snapshots/README.md).
