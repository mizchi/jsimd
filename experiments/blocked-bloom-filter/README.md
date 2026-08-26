# Blocked Bloom filter benchmark

This benchmark is the admission gate for `@mizchi/jsimd/blocked-bloom-filter`. It inserts 262,144
`u32` keys, evaluates roughly one million queries, and compares:

- the Wasm-v128 blocked filter with its JS/Wasm copies included;
- an equivalent scalar JavaScript blocked filter backed by `Uint32Array`;
- Bloom filtering followed by exact `Set.has` candidate verification;
- direct `Set.has` over every query;
- construction of both filters and `Set`.

Separate query mixes contain 90%, 50%, and 10% misses plus an all-hit case. This records the
end-to-end crossover rather than admitting the package from an isolated SIMD kernel win. The
negative-heavy workloads won, while the all-hit case lost and the 10%-miss case was near parity. See
[`src/blocked-bloom-filter/README.md`](../../src/blocked-bloom-filter/README.md) for exact results,
false-positive rate, layout, sources, trade-offs, and standalone build size.

```sh
pnpm bench:blocked-bloom-filter
pnpm bench:record:blocked-bloom-filter
pnpm bench:compare:blocked-bloom-filter
```
