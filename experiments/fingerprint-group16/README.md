# FingerprintGroup16 experiment

Compares resident Wasm `i8x16.eq`/`i8x16.bitmask` probes with a direct 16-byte JavaScript loop for
single-call and batched workloads.

Recorded with Vitest 4.1.11 / Node 24.12 / Apple M5:

| operation                   |     Wasm | JavaScript |
| :-------------------------- | -------: | ---------: |
| 1,024 individual probes     |  6.17 us |    5.08 us |
| 131,072 probes in one batch | 485.5 us |   775.0 us |
| 131,072 multi-group probes  | 218.6 us |   1.073 ms |

```sh
pnpm bench:fingerprint-group16
pnpm bench:record:fingerprint-group16
```
