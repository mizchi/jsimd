# jsimd workspace

This repository is a monorepo for small WebAssembly SIMD data structures and the higher-level
libraries built from them.

| Package                                                                       | Responsibility                                    | Status               |
| ----------------------------------------------------------------------------- | ------------------------------------------------- | -------------------- |
| [`@mizchi/jsimd`](./packages/jsimd/README.md)                                 | SIMD kernels, Float32 fusion, and data structures | Published            |
| [`@mizchi/jsimd-shared`](./packages/shared/README.md)                         | SharedArrayBuffer and Web Worker primitives       | Compatibility facade |
| [`@mizchi/jsimd-moonbit-interop`](./packages/moonbit-interop/README.md)       | MoonBit JS-backend view adapters                  | Compatibility facade |
| [`@mizchi/jsimd-validator`](./packages/validator/README.md)                   | Wasm SIMD validation for typed numeric arrays     | Release candidate    |
| [`@mizchi/jsimd-validator-compiler`](./packages/validator-compiler/README.md) | Schema-specialized Wasm SIMD AOT compiler         | Release candidate    |
| [`@mizchi/jsimd-columnar`](./packages/columnar/README.md)                     | Typed schema and page storage engine              | Experimental         |
| [`@mizchi/jsimd-olap`](./packages/olap/README.md)                             | Parallel analytical execution over typed columns  | Experimental         |
| [`@mizchi/jsimd-bench`](./packages/bench/README.md)                           | Reproducible Node and browser benchmark records   | Internal             |

Higher-level vector-search and WebGPU work remains under [`experiments`](./experiments) until its
public API and dispatch policy are stable. Runnable integrations remain under
[`examples`](./examples).

## Development

Node.js 24.5 or newer, Deno 2.6 or newer, pnpm, `just`, `wasm-tools`, and Vite 8 are required.

```sh
pnpm install
just check
```

The current compatibility dependency direction is intentionally one-way:

```text
@mizchi/jsimd ── @mizchi/jsimd-shared
       │
       ├──────── @mizchi/jsimd-moonbit-interop
       │
       └──────── @mizchi/jsimd-columnar

@mizchi/jsimd-shared + @mizchi/jsimd-columnar
       └──────── @mizchi/jsimd-olap

@mizchi/jsimd-validator (dependency-free)
@mizchi/jsimd-validator-compiler (build-time only)

packages
       └──────── parallel experiments
```

Experiments may depend on any package. Published packages must not depend on experiments.

Validator package release operations are documented in
[`docs/validator-release.md`](./docs/validator-release.md). Wasm AOT benchmark and supported-schema
details live with the [`validator compiler`](./packages/validator-compiler/README.md).
