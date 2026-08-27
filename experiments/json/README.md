# @mizchi/jsimd/json experiment

Benchmarks the copy-inclusive Wasm SIMD JSON token-start scanner against the equivalent scalar
JavaScript state machine.

```ts
import { jsonTokenStarts } from "@mizchi/jsimd/json";

const input = new TextEncoder().encode('{"ok":true}');
const starts = jsonTokenStarts(input);
```

## Recorded result

Deno 2.6.4 / Apple M5:

| workload                        | Wasm SIMD | scalar lexer | speedup |
| ------------------------------- | --------: | -----------: | ------: |
| 38 KiB mixed objects            |   56.1 us |     196.0 us |    3.5x |
| 60 KiB punctuation-dense arrays |  175.7 us |     519.1 us |    3.0x |
| 75 KiB long strings             |  150.1 us |     166.4 us |    1.1x |

## Reproduce and compare

```sh
pnpm bench:json
pnpm bench:record:json
```

The committed baseline is environment-specific and should only be compared on the same designated
machine/runtime.
