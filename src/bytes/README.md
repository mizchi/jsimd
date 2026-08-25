# Byte kernels

Byte-oriented SIMD kernels derived from patterns in `moonbitlang/core`. Import them from the main
package entrypoint:

```ts
import {
  bytesEqual,
  findByte,
  findNonAscii,
  indexOfSubarray,
  lexicalCompare,
  reverseFindByte,
} from "@mizchi/jsimd";
```

The wrappers include JavaScript-to-Wasm copies in their cost model and use native JavaScript paths
where crossing the boundary is slower.

## Benchmark

Recorded on Deno 2.6.4 / Apple M5. Byte-kernel timings include copying inputs from JavaScript into
Wasm scratch memory.

| workload                      | Wasm SIMD |          JavaScript reference | speedup |
| ----------------------------- | --------: | ----------------------------: | ------: |
| `findByte`, 4 KiB miss        |   0.37 us | 1.8 us (`Uint8Array#indexOf`) |    4.9x |
| `reverseFindByte`, 4 KiB miss |    1.7 us |        8.5 us (`lastIndexOf`) |    5.0x |
| `findNonAscii`, 4 KiB ASCII   |   0.75 us |         10.0 us (scalar loop) |   13.3x |
| `bytesEqual`, equal 4 KiB     |    1.5 us |         16.0 us (scalar loop) |   10.7x |
| `lexicalCompare`, equal 4 KiB |   0.69 us |          4.1 us (scalar loop) |    5.9x |
| `indexOfSubarray`, 4 KiB miss |   0.94 us |         17.0 us (scalar loop) |   18.1x |

Very small inputs use JavaScript paths because copy and call overhead dominate.

Reproduce from the repository root:

```sh
just bench
```

Files:

- `mod.ts`: public TypeScript API and copy/scratch-memory policy
- `kernels.wat`: hand-written Wasm SIMD source
- `kernels.d.wasm.ts`: typed Wasm module contract
- `kernels.wasm`: generated, stripped, and validated by `just build`; not tracked by Git

The benchmark implementation is in [`bench.ts`](../../bench.ts).
