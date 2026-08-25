# Byte-key flat hash experiment

Compares resident variable-length byte keys with a native `Map<string, number>`. Native binary keys
are precomputed as hexadecimal strings, so conversion and construction are excluded from lookup.

Run and record the benchmark with:

```sh
pnpm bench:byte-key-flat-hash
pnpm bench:record:byte-key-flat-hash
pnpm bench:compare:byte-key-flat-hash
```
