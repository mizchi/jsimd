# StaticMphfBytes rejected experiment

This prototype is archived under [`prototype/`](./prototype/) and is not part of the package
exports, production build, validation, memory profile, or published `dist/`. The benchmark commands
generate and validate its ignored Wasm binary before running, so the rejection remains reproducible
without adding its cost to users' installations.

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

# Optional prototype correctness and allocator checks
pnpm test:prototype:static-mphf-bytes

# Optional archived bundle-size fixture (after either command above generated Wasm)
pnpm exec tsc -p experiments/static-mphf-bytes/tree-shake-fixture/tsconfig.json
pnpm exec vite build experiments/static-mphf-bytes/tree-shake-fixture
```
