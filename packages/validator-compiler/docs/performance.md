# Performance and build size

The Wasm backend is optimized for hot boolean validation of wide numeric objects. Always benchmark
the actual schema and deployment runtime before choosing it.

## Method

The tables below were measured with Deno 2.6.4, V8 14.2, and Apple M5. Schema compilation and Wasm
instantiation are outside the timed region. Lower values are better.

The compared libraries expose different invalid-input and diagnostic semantics. These measurements
describe the fixtures, not universal rankings.

## Validation speed

| Fields / input     | Wasm SIMD AOT | Zod compile |  Valibot |  ArkType |
| ------------------ | ------------: | ----------: | -------: | -------: |
| 8 / valid          |       54.0 ns |     46.3 ns |   1.0 us | 234.4 ns |
| 8 / late invalid   |       51.3 ns |     11.3 us | 956.3 ns |  28.9 ns |
| 32 / valid         |      114.1 ns |    191.5 ns |   4.6 us |   1.5 us |
| 32 / late invalid  |      116.5 ns |     12.3 us |   3.0 us | 459.8 ns |
| 128 / valid        |      349.0 ns |     10.3 us |  48.2 us |  13.2 us |
| 128 / late invalid |      479.8 ns |     42.5 us |  37.8 us | 887.3 ns |

Run the comparison on the deployment target:

```sh
just bench-validator-compiler-wasm-libraries
```

## Build size

The same 32-field strict numeric object was bundled for browsers with esbuild 0.28.2, ESM output,
minification, and an ES2022 target. The jsimd binary was then processed by Binaryen 132 using
`wasm-opt -Oz --enable-simd`. Wasm size is separate from its generated JavaScript glue.

| Runtime                        | Minified JS |    Wasm |     Total |  Gzip JS | Gzip Wasm | Gzip total |
| ------------------------------ | ----------: | ------: | --------: | -------: | --------: | ---------: |
| jsimd Wasm SIMD AOT + wasm-opt |     2.46 kB | 1.01 kB |   3.47 kB |  0.67 kB |   0.34 kB |    1.01 kB |
| Zod compile                    |    98.73 kB |       — |  98.73 kB | 28.50 kB |         — |   28.50 kB |
| Zod Mini compile               |    46.82 kB |       — |  46.82 kB | 13.84 kB |         — |   13.84 kB |
| Valibot is                     |     3.87 kB |       — |   3.87 kB |  1.45 kB |         — |    1.45 kB |
| ArkType allows                 |   153.52 kB |       — | 153.52 kB | 47.58 kB |         — |   47.58 kB |

The generated Wasm declaration adds 1.12 kB before compression. For this already compact single
schema, `wasm-opt` did not reduce the raw size and increased gzip by 0.01 kB. The optimization pass
is optional because its effect depends on the generated module.

## Batch size

Compiling four exported 32-field schemas together shares JavaScript helpers, Wasm type entries, and
module sections. Both layouts below include the same `wasm-opt` pass.

| Layout             | Minified JS |    Wasm |    Total | Gzip total |
| ------------------ | ----------: | ------: | -------: | ---------: |
| Separate artifacts |     9.83 kB | 4.05 kB | 13.88 kB |    4.03 kB |
| Shared batch       |     9.30 kB | 3.17 kB | 12.47 kB |    1.67 kB |

The shared batch reduces raw runtime assets by 1.41 kB and the sum of separately compressed assets
by 2.36 kB in this fixture. Generated TypeScript declarations are excluded from runtime bundle
sizes. Output size varies with schema width and selected target.

Reproduce the table with:

```sh
just measure-validator-wasm-comparison
```
