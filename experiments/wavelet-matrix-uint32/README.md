# WaveletMatrixUint32 experiment

The benchmark compares the immutable Wasm wavelet matrix with the strongest simple JavaScript
baseline appropriate to each query: direct `Uint32Array` access, a value-to-sorted-positions map for
exact rank, copy-and-sort for range quantile, and a scalar typed-array scan for range frequency.

```sh
pnpm bench:wavelet-matrix-uint32
pnpm bench:record:wavelet-matrix-uint32
```

The committed shared-schema result lives in `benchmarks/baseline.json`. The entrypoint README
summarizes the recorded numbers and trade-offs.
