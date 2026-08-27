# Fixed16 flat hash experiment

Compares bulk lookup of resident 16-byte keys with `Map<string, number>` and `Set<string>` using
precomputed hexadecimal strings. Construction and string conversion are excluded from lookup.

Recorded with Vitest 4.1.11 / Node 24.12 / Apple M5:

| lookup workload | Fixed16 Wasm | native string collection |
| :-------------- | -----------: | -----------------------: |
| map             |      1.41 ms |                 39.30 ms |
| set             |      1.34 ms |                 34.24 ms |

```sh
pnpm bench:flat-hash-fixed16
pnpm bench:record:flat-hash-fixed16
```
