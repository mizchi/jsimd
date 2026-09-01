# Compiler backends

The compiler has two explicit output backends. Wasm SIMD AOT is the default. JavaScript AOT is
available for a broader JSON-like identity-validation subset. The compiler never switches between
them automatically.

## Wasm SIMD AOT

The Wasm backend emits three files:

- `.wasm`: schema-specialized `f64x2` SIMD range checks
- `.js`: shape and type guards plus the Wasm factory
- `.d.ts`: inferred `Output` and factory types

The generated factory exposes `instantiate(source)`. Its returned validator exposes only the boolean
type guard `is(input)`.

### Batch all module exports

When a module path has no `#Name` fragment, the CLI compiles all of its runtime exports into one
Wasm module and one shared JavaScript glue file:

```sh
pnpm exec jsimd-validator-compiler \
  ./schemas.ts \
  --out ./generated/validators
```

The source module should export schemas only. Every export is normalized and checked against the
Wasm subset. If one is unsupported, compilation fails with that export name.

```ts
import { readFile } from "node:fs/promises";
import { instantiate, type Packet, type Telemetry } from "./generated/validators.js";

const bytes = await readFile(new URL("./generated/validators.wasm", import.meta.url));
const validators = instantiate(bytes);

validators.Packet.is(packet);
validators.Telemetry.is(telemetry);
```

The `.d.ts` file exports an `Outputs` interface, a type alias for each compatible named export, and
a `WasmValidators` interface. A `default` export remains accessible through `Outputs["default"]` and
`validators.default`.

Use `module.ts#Name` to generate the single-validator `instantiate(...).is(...)` API instead.

### Optional wasm-opt pass

`--wasm-opt` applies Binaryen after schema compilation:

```sh
pnpm add -D binaryen
pnpm exec jsimd-validator-compiler \
  ./schemas.ts \
  --out ./generated/validators \
  --wasm-opt
```

The compiler invokes `wasm-opt -Oz --enable-simd`. `wasm-opt` must be available on `PATH`, and a
missing executable is a build error. This option is Wasm-only and never changes validation
semantics.

### Accepted shape

The root must be a strict object with at most 256 root properties and 8–256 statically addressable
numeric leaves across the full schema.

Supported fields are:

- required finite `number` and `integer` values with inclusive or exclusive bounds
- required strings with `maxLength`
- nested strict objects
- bounded homogeneous arrays
- fixed-length arrays whose numeric leaves can be flattened

Generated JavaScript checks object shape, primitive types, integer constraints, Unicode string
lengths, nested objects, and variable-length arrays. Numeric values are passed directly as Wasm
parameters. No temporary flat array or Wasm-memory copy is allocated.

The backend rejects optional fields, unknown-key-permitting objects, unions, unbounded strings or
arrays, diagnostics, Standard Schema output, and JSON parsing.

### Instantiation

```ts
import { readFile } from "node:fs/promises";
import { instantiate } from "./generated/telemetry.js";

const bytes = await readFile(new URL("./generated/telemetry.wasm", import.meta.url));
const validator = instantiate(bytes);

validator.is(input);
```

Compile and instantiate outside the validation hot path. Reuse one validator for all values matching
the schema.

## JavaScript AOT

Select JavaScript output explicitly:

```sh
pnpm exec jsimd-validator-compiler \
  ./schema.ts#User \
  --out ./generated/user \
  --javascript
```

This backend emits standalone `.js` and `.d.ts` files. It supports the normalized JSON-like subset,
including optional object fields, loose objects, literals, primitive enums, unions, and bounded or
unbounded strings and arrays.

The default target exports `is`, raw `validate`, and a Standard Schema wrapper:

```ts
import validator, { is, type Output as User, validate } from "./generated/user.js";

if (is(input)) {
  const user: User = input;
}

const result = validate(input);
await validator["~standard"].validate(input);
```

Additional CLI modes:

```sh
# is(input) only
jsimd-validator-compiler ./schema.ts#User --out ./generated/user --javascript --boolean-only

# is(input) plus raw diagnostics, without Standard Schema
jsimd-validator-compiler ./schema.ts#User --out ./generated/user --javascript --diagnostic-only
```

`--json-parser` adds `parseJSON(text)`, which calls native `JSON.parse` before validation.
`--single-pass-diagnostics` avoids the default valid-first pass when invalid inputs and diagnostics
dominate the workload.

Raw issues contain an enum-like `code`, positional `args`, and `path`. Message formatting can stay
in a separate debug-only endpoint.

## Programmatic API

`compileSchema` and `compileSchemaAsync` return the same artifacts as the CLI:

```ts
import { compileSchema, compileSchemaAsync } from "@mizchi/jsimd-validator-compiler";

const wasm = compileSchema(jsonSchema);
wasm.files.wasm; // Uint8Array
wasm.files.javascript;
wasm.files.typescript;

const javascript = compileSchema(jsonSchema, {
  backend: "javascript",
});

const valibot = await compileSchemaAsync(valibotSchema);
```

Use `compileSchemaAsync` when Valibot adapter loading is required. The compiler writes the Wasm
binary directly and does not invoke an external Wasm toolchain.
