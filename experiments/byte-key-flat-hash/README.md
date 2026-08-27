# Byte-key flat hash experiment

Compares resident variable-length byte keys with a native `Map<string, number>`. Native binary keys
are precomputed as hexadecimal strings, so conversion and construction are excluded from lookup.

Recorded with Vitest 4.1.11 / Node 24.12 / Apple M5:

| lookup workload       | byte-key Wasm | `Map<string, number>` |
| :-------------------- | ------------: | --------------------: |
| 65,536-key bulk       |       1.41 ms |               2.82 ms |
| 4,096 individual gets |       0.79 ms |               0.06 ms |

Bulk lookup is 2.00x faster; individual Wasm calls are 12.5x slower.

Run and record the benchmark with:

```sh
pnpm bench:byte-key-flat-hash
pnpm bench:record:byte-key-flat-hash
```
