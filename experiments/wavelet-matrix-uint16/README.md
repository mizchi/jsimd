# WaveletMatrixUint16 experiment

The retained workload compares 16-level and 32-level wavelet matrices over 262,144 UTF-16-sized
values. Batched rank is also compared with a JavaScript value-to-sorted-positions index, while
batched quantile is compared with copying and sorting each queried range.

Recorded on Apple M5 / Node 24. The 16-level matrix was 2.30x faster than the 32-level matrix for
`rankMany` and 2.47x faster for `quantileMany`. Quantile was 329x faster than copying and sorting
each range. A JavaScript value-to-sorted-positions index answered exact rank 14.4x faster, and
direct `Uint16Array` access was 67x faster than indexed access.

Run `pnpm bench:wavelet-matrix-uint16` to reproduce the measurements.
