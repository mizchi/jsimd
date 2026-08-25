# BinaryVectorIndex experiment

Compares copy-inclusive Wasm SIMD Hamming distance against a scalar JavaScript popcount-table loop
over 65,536 256-bit signatures. The committed baseline showed a 7.82x SIMD advantage.

See the [entrypoint README](../../src/binary-vector-index/README.md) for API and trade-offs.
