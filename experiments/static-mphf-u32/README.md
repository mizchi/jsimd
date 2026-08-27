# StaticMphfU32 experiment

The lookup benchmark uses 262,144 unique `Uint32` keys and 4,096 mixed hit/miss queries. It compares
batched and repeated-single MPHF calls with `FlatHashSetU32` and `Set<number>`. A separate
16,384-key suite records construction cost.

The committed result validates a narrow use case: MPHF wins batch throughput and frozen logical
bytes, but loses badly for repeated JS/Wasm single calls and for construction. See the
[entrypoint README](../../packages/jsimd/src/static-mphf-u32/README.md) for numbers, membership
semantics, design sources, and standalone size.

```sh
pnpm bench:static-mphf-u32
pnpm bench:record:static-mphf-u32
```
