# Uint8Array operations

Copy-inclusive SIMD operations for `Uint8Array`. Import them from the dedicated `bytes` subpath:

```ts
import { compare, equals, indexOf, indexOfNonAscii, lastIndexOf } from "@mizchi/jsimd/bytes";
```

The wrappers include JavaScript-to-Wasm copies in their cost model and use native JavaScript paths
where crossing the boundary is slower.

## Benchmark

Recorded on Deno 2.6.4 / Apple M5. Byte-kernel timings include copying inputs from JavaScript into
Wasm scratch memory.

| workload                          | Wasm SIMD |          JavaScript reference | speedup |
| --------------------------------- | --------: | ----------------------------: | ------: |
| `indexOf(number)`, 4 KiB miss     |   0.37 us | 1.8 us (`Uint8Array#indexOf`) |    4.9x |
| `lastIndexOf`, 4 KiB miss         |    1.7 us |        8.5 us (`lastIndexOf`) |    5.0x |
| `indexOfNonAscii`, 4 KiB ASCII    |   0.75 us |         10.0 us (scalar loop) |   13.3x |
| `equals`, equal 4 KiB             |    1.5 us |         16.0 us (scalar loop) |   10.7x |
| `compare`, equal 4 KiB            |   0.69 us |          4.1 us (scalar loop) |    5.9x |
| `indexOf(Uint8Array)`, 4 KiB miss |   0.94 us |         17.0 us (scalar loop) |   18.1x |

Very small inputs use JavaScript paths because copy and call overhead dominate.

`indexOf` accepts either a numeric byte or a `Uint8Array` sequence. Numeric searches also preserve
the optional `[start, end)` bounds.

Reproduce from the repository root:

```sh
just bench
```

Files:

- `mod.ts`: public exports
- `operations.ts`: copy/scratch-memory policy and SIMD operation wrappers
- `kernels.wat`: hand-written Wasm SIMD source
- `kernels.d.wasm.ts`: typed Wasm module contract
- `kernels.wasm`: generated, stripped, and validated by `just build`; not tracked by Git

The benchmark implementation is in [`bench.ts`](../../bench.ts).

The isolated Vite fixture emits one 0.98 kB Wasm asset (0.50 kB gzip) and a 2.87 kB minified JS
wrapper (1.40 kB gzip). The fixture imports only `indexOf`; no other entrypoint's Wasm is emitted.
