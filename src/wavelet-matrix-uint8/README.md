# WaveletMatrixUint8

An immutable eight-level wavelet matrix for bytes. It supports access, rank, select, range
frequency, quantile, predecessor, and batched access/rank/quantile without storing 32 bit levels for
an eight-bit alphabet.

```ts
import { WaveletMatrixUint8 } from "@mizchi/jsimd/wavelet-matrix-uint8";

using bytes = WaveletMatrixUint8.from(new TextEncoder().encode("banana"));
bytes.rank("a".charCodeAt(0), bytes.length); // 3
bytes.quantile(0, bytes.length, 0); // "a" (97)
```

Each level stores one bit per value and a cumulative rank every 512 bits. The logical resident size
approaches 1.0625 bytes per input byte, plus padding and eight zero counters. This is useful when
the same frozen sequence receives many rank/range queries, and is the BWT rank layer used by
`FmIndexBytes`.

Use `serialize()` and `WaveletMatrixUint8.fromSnapshot(bytes)` to persist the bit levels, rank
prefixes, and zero boundaries without replaying stable partitions. For 65,536 bytes the snapshot was
69,728 bytes and restored about 21x faster than rebuilding in the recorded resident benchmark.

## Performance and trade-offs

On Apple M5 / Node 24.12 / Vitest 4.1.11, for 4,096 queries over 262,144 values:

| operation    | byte matrix | 32-level matrix | result                              |
| :----------- | ----------: | --------------: | :---------------------------------- |
| `rankMany`   |   0.2742 ms |       1.3162 ms | byte specialization is 4.80x faster |
| `accessMany` |   0.2766 ms |       1.3031 ms | byte specialization is 4.71x faster |

Direct `Uint8Array` access took 0.0115 ms and was about 24x faster than `accessMany`. Do not use a
wavelet matrix as an ordinary array. Its benefit is the rank/select and range-statistics index; it
also costs slightly more than the raw bytes and has a nontrivial frozen build.

## Standalone build size

The isolated Vite 8.2 production fixture emits 11.77 kB minified JavaScript (4.25 kB gzip) and one
2.10 kB Wasm asset (0.97 kB gzip).

Sources: the
[JSAI succinct-data-structure overview](https://www.ai-gakkai.or.jp/resource/my-bookmark/my-bookmark_vol26-no6/),
[Faster Wavelet Tree Queries](https://arxiv.org/html/2302.09239v2), and the
[benchmark source](../../experiments/wavelet-matrix-uint8/wavelet-matrix-uint8.bench.ts). Snapshot
format and transport measurements are in
[`experiments/snapshots`](../../experiments/snapshots/README.md).
