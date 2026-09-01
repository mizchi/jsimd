# `@mizchi/jsimd-validator-compiler`

Binary-oriented AOT validator with a Zod-like build workflow. Define a schema, compile it ahead of
time into a schema-specialized Wasm SIMD predicate, then import the generated validator.

Inputs remain ordinary JavaScript values. “Binary-oriented” refers to compiling fixed-width numeric
constraints into a standalone Wasm binary instead of interpreting a schema at validation time.

Generated validators do not depend on Zod, Valibot, this compiler, or `@mizchi/jsimd-validator` at
runtime. Unsupported semantics fail at build time.

## Install

The compiler requires Node.js 24 or newer:

```sh
pnpm add -D @mizchi/jsimd-validator-compiler
```

## Quick start: Wasm SIMD AOT

Define a strict schema with at least eight statically addressable numeric leaves:

```ts
// schema.ts
import { array, i16, strictObject, string, u16, u8 } from "@mizchi/jsimd-validator-compiler";

export const Packet = strictObject({
  header: strictObject({
    kind: u8(),
    flags: u8(),
    width: u16(),
    height: u16(),
  }),
  samples: array(i16({ min: -1000, max: 1000 }), {
    minLength: 4,
    maxLength: 4,
  }),
  label: string({ minLength: 1, maxLength: 64 }),
});
```

Compile it before the application build:

```sh
pnpm exec jsimd-validator-compiler \
  ./schema.ts#Packet \
  --out ./generated/packet
```

This emits `packet.wasm`, `packet.js`, and `packet.d.ts`. Import only the generated module in the
application:

```ts
import { readFile } from "node:fs/promises";
import { instantiate, type Output as Packet } from "./generated/packet.js";

const wasm = await readFile(new URL("./generated/packet.wasm", import.meta.url));
const validator = instantiate(wasm);

export function receive(input: unknown): Packet {
  if (!validator.is(input)) throw new TypeError("Invalid packet");
  return input;
}
```

Instantiate once and reuse the validator. Wasm SIMD AOT is the CLI and programmatic default.

## Compile all exported schemas

Omit `#Name` to compile every runtime export from a schema-only module into one shared artifact:

```sh
pnpm exec jsimd-validator-compiler \
  ./schemas.ts \
  --out ./generated/validators
```

The generated factory returns one validator per export, while the declaration exposes each output
type:

```ts
import { readFile } from "node:fs/promises";
import { instantiate, type Packet, type Telemetry } from "./generated/validators.js";

const wasm = await readFile(new URL("./generated/validators.wasm", import.meta.url));
const validators = instantiate(wasm);

validators.Packet.is(input);
validators.Telemetry.is(input);
```

Shared JavaScript glue, Wasm sections, and function signatures are emitted once. Use `#Name` when
only one export should be compiled. A non-schema export fails the build with its export name.

Add `--wasm-opt` to run Binaryen `wasm-opt -Oz --enable-simd` on the generated binary. The command
must be available on `PATH`; installing `binaryen` as a development dependency and invoking the CLI
through `pnpm exec` provides it locally.

## Where it fits

This package is designed for hot boolean validation of strict, numeric, fixed-shape objects. It is
most effective with 8–256 numeric leaves, especially wide objects, nested strict objects, and
fixed-length numeric arrays.

It is not a general replacement for Zod, Valibot, or ArkType. Keep the source library when you need
transforms, coercion, defaults, custom refinements, regex, formats, recursion, or detailed error
trees. String-heavy and variable-array-heavy schemas receive less SIMD benefit.

Unsupported Wasm schemas are rejected instead of silently selecting a different backend.

## Zod, Valibot, and JSON Schema

The CLI accepts an exported Zod schema through Standard JSON Schema:

```sh
pnpm add -D zod
pnpm exec jsimd-validator-compiler ./schema.ts#Telemetry --out ./generated/telemetry
```

It also accepts JSON Schema files directly. Valibot sources require the optional build dependency
`@valibot/to-json-schema`.

The generated `.d.ts` contains the inferred `Output` type. Zod and Valibot are schema sources only;
they are not imported by the generated validator.

## JavaScript AOT fallback

Choose JavaScript AOT instead for supported JSON-like identity schemas that need optional fields,
unions, raw diagnostics, or a Standard Schema wrapper:

```sh
pnpm exec jsimd-validator-compiler \
  ./schema.ts#User \
  --out ./generated/user \
  --javascript
```

This emits standalone `.js` and `.d.ts` files. There is no automatic fallback from Wasm.

## Performance snapshot

Valid-path measurements on Deno 2.6.4, V8 14.2, and Apple M5 exclude compilation and instantiation.
Lower is better.

| Fields / input | Wasm SIMD AOT | Zod compile | Valibot |  ArkType |
| -------------- | ------------: | ----------: | ------: | -------: |
| 8 / valid      |       54.0 ns |     46.3 ns |  1.0 us | 234.4 ns |
| 32 / valid     |      114.1 ns |    191.5 ns |  4.6 us |   1.5 us |
| 128 / valid    |      349.0 ns |     10.3 us | 48.2 us |  13.2 us |

Build-size baselines use esbuild 0.28.2 and Binaryen 132 `wasm-opt -Oz --enable-simd`:

| Fixture                     | Minified JS |    Wasm |    Total | Gzip total |
| --------------------------- | ----------: | ------: | -------: | ---------: |
| 32-field schema             |     2.46 kB | 1.01 kB |  3.47 kB |    1.01 kB |
| Shared batch, 4 x 32 fields |     9.30 kB | 3.17 kB | 12.47 kB |    1.67 kB |

See the detailed methodology, invalid paths, and comparison caveats in
[Performance and build size](./docs/performance.md).

## Documentation

- [Supported schemas and helper API](./docs/schema-support.md)
- [Wasm and JavaScript backends](./docs/backends.md)
- [Validation performance and build size](./docs/performance.md)

## Examples

- [Zod to standalone Wasm SIMD validator](../../examples/validator-compiler-zod-wasm/README.md)
- [Zod to standalone JavaScript validator](../../examples/validator-compiler-zod/README.md)

## License

MIT
