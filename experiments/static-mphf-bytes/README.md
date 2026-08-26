# StaticMphfBytes experiment

The lookup suite uses 65,536 unique variable-length byte keys and 4,096 mixed exact hit/miss
queries. Native `Set<string>` receives pre-encoded hex strings, so encoding cost is excluded for the
JavaScript baseline. Construction is measured separately over 16,384 keys.

Recorded on Apple M5 / Node 24.12: `lookupMany` took 0.1209 ms, versus 0.0534 ms for pre-encoded
`Set<string>` and 1.6283 ms when each query was encoded to hex. MPHF construction took 31.86 ms
versus 0.3361 ms for the pre-encoded set.

```sh
pnpm bench:static-mphf-bytes
pnpm bench:record:static-mphf-bytes
pnpm bench:compare:static-mphf-bytes
```
