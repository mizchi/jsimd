# BlockedVectorArray experiment

Compares the 64-vector dimension-major PDX layout with the existing four-vector PDX implementation
and an indexed row-major JavaScript scalar loop. Construction is measured separately so the query
result does not hide the cost of transposing source data. The retained benchmark also covers L1,
inner product, and fused inner-product top-k.

The committed Apple M5 / Node 24 baseline for 16,384 vectors × 64 dimensions measured the PDX64
distance scan at 0.0611 ms, PDX4 at 0.1053 ms, and JavaScript at 0.5623 ms. PDX64 was therefore
1.72x faster than PDX4 and 9.21x faster than JavaScript.

Fused `topKInto` took 0.0621 ms for `k=10`, versus 0.0887 ms for the same distance scan followed by
a reused bounded JavaScript heap and 2.2223 ms for a reused full sort. At `k=100`, fused selection
took 0.0681 ms versus 0.1014 ms for the JavaScript heap. Construction took 0.8585 ms versus 0.1185
ms for a plain `Float32Array.slice`, so this remains a repeated-query representation rather than a
faster copy.

The repeated-query extension measured L1 at 0.1054 ms versus 0.5101 ms for scalar JavaScript (4.84x)
and inner product at 0.0990 ms versus 0.8223 ms (8.31x). Fused inner-product top-k took 0.1083 ms
versus 0.1338 ms for materializing scores and using a bounded JavaScript heap (1.24x).

See the [entrypoint README](../../src/blocked-vector-array/README.md) for API, layout, sources,
trade-offs, and isolated build size.
