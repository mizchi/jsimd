# Rejected LOUDS topology experiment

This prototype encodes an 87,381-node complete 4-ary tree in standard LOUDS and derives 4,096
parents with batched `select1` followed by batched `rank1`. It compares the compact topology with a
direct `Uint32Array` parent table. The result is kept as rejection evidence; no public entrypoint or
additional Wasm asset is shipped.

Recorded on Apple M5 / Node 24.12: LOUDS `select1Many` plus `rank1Many` took 0.0758 ms; direct
`Uint32Array` parent access took 0.0113 ms and was 6.70x faster.
