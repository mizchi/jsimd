# JSON lexer

A UTF-8 JSON token-start scanner with SIMD byte classification and an in-Wasm string/escape/atom
state machine.

```ts
import { jsonTokenStarts } from "@mizchi/jsimd/json";

const input = new TextEncoder().encode('{"ok":true}');
jsonTokenStarts(input); // UTF-8 byte offsets
```

The result contains offsets for structural characters, opening and closing quotes, and atom starts.
Input is copied to Wasm scratch memory once per call; classification, state transitions, and output
emission happen inside Wasm.

## Benchmark

Recorded on Deno 2.6.4 / Apple M5, including the JavaScript-to-Wasm input copy and copying output
positions back to JavaScript.

| workload                        | Wasm SIMD | scalar lexer | speedup |
| ------------------------------- | --------: | -----------: | ------: |
| 38 KiB mixed objects            |   56.1 us |     196.0 us |    3.5x |
| 60 KiB punctuation-dense arrays |  175.7 us |     519.1 us |    3.0x |
| 75 KiB long strings             |  150.1 us |     166.4 us |    1.1x |

Long strings are close to scalar performance because both implementations still inspect every byte.
The largest gains come from classification-heavy JSON with many structural tokens.

```sh
pnpm bench:json
pnpm bench:record:json
pnpm bench:compare:json
```

Files:

- `mod.ts`: public TypeScript API and scratch-memory policy
- `kernels.wat`: SIMD classification and JSON state machine
- `kernels.d.wasm.ts`: typed Wasm module contract
- `kernels.wasm`: generated, stripped, and validated by `just build`; Git-ignored
