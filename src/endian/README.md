# Endian decoding

Copy-inclusive batched decoding of unsigned 32-bit integers. Import this optional entrypoint without
adding its Wasm binary to the main byte kernels:

```ts
import { decodeUint32BE, decodeUint32LE } from "@mizchi/jsimd/endian";

const values = decodeUint32BE(
  new Uint8Array([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]),
);
// Uint32Array [0x01234567, 0x89abcdef]
```

The input length must be a multiple of four. Returned arrays are JavaScript-owned and do not require
disposal. Little-endian decoding uses a native typed-array copy on little-endian hosts. Big-endian
decoding uses `DataView` below 512 bytes and a SIMD byte shuffle for larger inputs.

## Benchmark

Recorded on Deno 2.6.4 / Apple M5, including copying into and out of Wasm:

| input bytes | hybrid SIMD | DataView loop | speedup |
| ----------: | ----------: | ------------: | ------: |
|          64 |     0.24 us |       0.24 us |    1.0x |
|         256 |     0.31 us |       0.31 us |    1.0x |
|         512 |     0.20 us |       0.28 us |    1.4x |
|       1,024 |     0.30 us |       0.39 us |    1.3x |
|       4,096 |     0.56 us |        1.2 us |    2.1x |
|      16,384 |      1.7 us |        3.7 us |    2.2x |

The separate stripped Wasm binary is 210 bytes. Vite isolation fixtures verify that importing the
main byte entrypoint does not include this binary, and importing this entrypoint does not include
the main byte kernels.

```sh
pnpm bench:endian
```

Files:

- `mod.ts`: public API, native fallback, and scratch-memory policy
- `kernels.wat`: SIMD 32-bit byte shuffle
- `kernels.d.wasm.ts`: typed Wasm module contract
- `kernels.wasm`: generated, stripped, and validated by `just build`; Git-ignored
