# BlockedVectorArray experiment

Compares the 64-vector dimension-major PDX layout with the existing four-vector PDX implementation
and an indexed row-major JavaScript scalar loop. Construction is measured separately so the query
result does not hide the cost of transposing source data.

The committed Apple M5 / Node 24 baseline for 16,384 vectors × 64 dimensions measured the PDX64
distance scan at 0.061 ms, PDX4 at 0.113 ms, and JavaScript at 0.564 ms. PDX64 was therefore 1.84x
faster than PDX4 and 9.21x faster than JavaScript. Construction took 0.924 ms versus 0.121 ms for a
plain `Float32Array.slice`, so this is a repeated-query representation rather than a faster copy. At
32 vectors × 64 dimensions, PDX64 remained 2.92x faster than JavaScript.

See the [entrypoint README](../../src/blocked-vector-array/README.md) for API, layout, sources,
trade-offs, and isolated build size.
