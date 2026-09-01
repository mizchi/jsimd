# `@mizchi/jsimd-validator-compiler`

Build-time compiler for schema-specialized Wasm SIMD AOT validators. It accepts a strict numeric
object subset with optional bounded-string fields from JSON Schema, Zod, and Valibot, then emits a
standalone `.wasm` predicate with small ESM glue and an inferred TypeScript declaration. Unsupported
semantics fail compilation instead of falling back to a slower approximation.

The generated validator has no dependency on Zod, Valibot, this compiler, or
`@mizchi/jsimd-validator`.

## Install

The compiler runs at build time on Node.js 24 or newer:

```sh
pnpm add -D @mizchi/jsimd-validator-compiler
```

Zod is shown below, but it is only a build-time schema source and remains an optional application
dependency.

## Where it fits

This compiler is a low-level identity validator rather than a general schema language. Its default
Wasm backend is designed for hot boolean paths where the schema is known at build time and numeric
range checks dominate the steady-state cost.

### Good fit for Wasm AOT

- strict records with 8–256 statically addressable numeric leaves, especially wide records with 32
  or more fields
- required finite integer/float range checks, including numeric leaves inside nested strict objects
  and fixed-length arrays
- bounded strings and variable-length bounded arrays as secondary fields around a numeric workload
- repeated boolean type-guard calls where schema compilation happens outside the measured runtime
- applications that can instantiate the generated Wasm once and reuse the validator
- deployments that benefit from standalone `.wasm`, ESM glue, and `.d.ts` files without shipping
  Zod, Valibot, ArkType, or this compiler at runtime

### Not a good fit for Wasm AOT

- small or rarely validated schemas, where Wasm startup and the JS-to-Wasm boundary have little
  opportunity to amortize; Zod compile was faster on the measured 8-field valid path
- schemas dominated by strings, nested shape traversal, or variable-length arrays: these checks run
  in generated JavaScript, so adding Wasm provides limited leverage
- optional or loose fields, recursive schemas, unions, unbounded strings/arrays, regex, formats,
  transforms, coercion, defaults, custom refinements, or exhaustive error trees
- request paths that need detailed diagnostics or a Standard Schema result from the Wasm artifact;
  the Wasm backend intentionally exports only `is(input)`
- JSON text parsing or streaming validation; the fused parser experiment was substantially slower
  than native `JSON.parse` followed by AOT validation
- code that would compile or instantiate the Wasm module for every input instead of reusing it
- cases optimizing only compressed transfer size: in the measured 32-field fixture, JavaScript AOT
  was 0.76 kB gzip while JavaScript glue plus Wasm totaled 1.00 kB gzip

Some JSON-like cases in this list remain supported by the explicit JavaScript AOT backend. Rich
schema semantics remain the responsibility of the source library.

### Choose the implementation by workload

| Requirement                                                                  | Recommended path                                             |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Hot boolean checks over a wide, numeric, fixed shape                         | Use the default Wasm SIMD AOT backend                        |
| Supported JSON-like shapes needing raw diagnostics or Standard Schema output | Choose JavaScript AOT instead with `--javascript`            |
| Small schemas or rich transforms/refinements/formats                         | Keep Zod, Valibot, or ArkType in the runtime path            |
| Already-columnar typed arrays or resident Wasm memory                        | Use `@mizchi/jsimd-validator` instead of the object compiler |
| JSON strings                                                                 | Use native `JSON.parse`, then call the generated validator   |

These are workload boundaries, not automatic fallback rules. Unsupported Wasm schemas fail at build
time so a performance or deployment change cannot happen silently.

## Numeric schema helpers

For the optimized numeric subset, the compiler includes small Valibot-style helpers. They build
serializable JSON Schema values and add no runtime dependency to generated validators:

```ts
// schema.ts
import {
  array,
  f32,
  f64,
  i16,
  i32,
  i8,
  strictObject,
  string,
  u16,
  u32,
  u8,
} from "@mizchi/jsimd-validator-compiler";

export const Telemetry = strictObject({
  status: u8(),
  port: u16({ min: 1 }),
  sequence: u32(),
  delta8: i8(),
  delta16: i16(),
  delta32: i32(),
  ratio: f32({ min: 0, max: 1 }),
  total: f64({ min: 0 }),
  label: string({ minLength: 1, maxLength: 64 }),
});
```

The available intrinsic ranges are `u8`, `u16`, `u32`, `i8`, `i16`, `i32`, `f32`, and `f64`.
Optional `min` and `max` bounds are inclusive and must stay inside the selected intrinsic range.
Unknown options and invalid ranges fail immediately. Integer helpers additionally emit an exact
`Number.isInteger` guard; their range predicates still run in the schema-specialized Wasm SIMD
module.

`f32` means a finite JavaScript number inside the IEEE 754 binary32 range. It does not require the
input number to already equal `Math.fround(input)`. TypeScript has no fixed-width scalar numeric
types, so generated `.d.ts` fields remain `number`; width, integer, and range are runtime
constraints.

`string({ maxLength, minLength? })` adds a required bounded string field. Length follows JSON Schema
and counts Unicode code points, using an ASCII fast path in generated glue. String checks remain in
JavaScript because Wasm cannot inspect arbitrary JavaScript strings directly.

`strictObject()` can be nested, and `array(item, { maxLength, minLength? })` creates a homogeneous
bounded array. Fixed-length arrays (`minLength === maxLength`) and nested objects are statically
flattened: their numeric leaves become direct Wasm parameters without allocating a temporary array.
Variable-length array items are checked in a generated bounded JavaScript loop. The complete schema
must contain 8–256 statically addressable numeric leaves so the Wasm module has a real SIMD
workload:

```ts
export const Packet = strictObject({
  header: strictObject({ kind: u8(), flags: u8(), width: u16(), height: u16() }),
  samples: array(i16(), { minLength: 4, maxLength: 4 }),
  tags: array(string({ maxLength: 16 }), { maxLength: 4 }),
});
```

## Quick start: Wasm SIMD AOT

Define a strict object containing 8–256 required finite-number fields. This 32-field example keeps
the source short while still producing one specialized validator:

```ts
// schema.ts
import * as z from "zod";

const metrics = Object.fromEntries(
  Array.from({ length: 32 }, (_, index) => [
    `value${index}`,
    z.number().min(index).max(index + 100),
  ]),
) as Record<string, z.ZodNumber>;

export const Telemetry = z.strictObject(metrics);
```

Compile it before bundling the application:

```sh
pnpm exec jsimd-validator-compiler \
  ./schema.ts#Telemetry \
  --out ./generated/telemetry
```

The command emits three independent files:

- `telemetry.wasm`: schema-specific `f64x2` SIMD range predicate
- `telemetry.js`: strict object shape/type guard and explicit Wasm instantiation
- `telemetry.d.ts`: inferred `Output` and validator factory types

Instantiate once and reuse the validator:

```ts
import { readFile } from "node:fs/promises";
import { instantiate } from "./generated/telemetry.js";

const bytes = await readFile(new URL("./generated/telemetry.wasm", import.meta.url));
const validator = instantiate(bytes);

validator.is(input);
```

The programmatic API exposes the same build product:

```ts
import { compileSchema } from "@mizchi/jsimd-validator-compiler";

const artifact = compileSchema(source);
artifact.files.wasm; // Uint8Array
artifact.files.javascript;
artifact.files.typescript;
```

The compiler encodes the Wasm binary directly and does not shell out to `wat2wasm`. See the complete
checked-in [`Zod Wasm example`](../../examples/validator-compiler-zod-wasm/README.md).

## JavaScript AOT fallback

Wasm SIMD AOT is the CLI and programmatic default. The backend deliberately rejects optional,
unbounded-string, unbounded-array, union, loose-object, parser, and diagnostic schemas. To compile
those supported JSON-like identity-validation shapes, select the dependency-free JavaScript AOT
backend explicitly:

```ts
// schemas.ts
import * as v from "valibot";
import * as z from "zod";

export const ZodUser = z.strictObject({
  name: z.string().min(1),
  age: z.number().int().min(0).max(130),
});

export const ValibotUser = v.strictObject({
  name: v.pipe(v.string(), v.minLength(1)),
  age: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(130)),
});
```

```sh
pnpm exec jsimd-validator-compiler ./schemas.ts#ZodUser --out ./generated/zod-user --javascript
pnpm exec jsimd-validator-compiler ./schemas.ts#ValibotUser --out ./generated/valibot-user --javascript
```

Each invocation emits `.js` and `.d.ts`. In the programmatic API, select it with
`compileSchema(source, { backend: "javascript" })`. There is no automatic fallback from Wasm:
unsupported schemas fail compilation. `code` and `declaration` remain aliases of `files.javascript`
and `files.typescript`.

Valibot入力にはbuild-timeのoptional peer `@valibot/to-json-schema`が必要です。CLIは
`~standard.vendor === "valibot"`を検出した場合だけadapterをdynamic importします。

For a boolean-only module without diagnostics or a Standard Schema wrapper:

```sh
jsimd-validator-compiler ./schemas.ts#User --out ./generated/user-is --javascript --boolean-only
```

For raw `code + args + path` diagnostics without a formatter or Standard Schema wrapper:

```sh
jsimd-validator-compiler ./schemas.ts#User --out ./generated/user-debug --javascript --diagnostic-only
```

```ts
import User, { validate } from "./generated/user.js";

const raw = validate(input);
const result = User["~standard"].validate(input);
```

`validate` returns raw enum-like issues. The default Standard Schema endpoint formats those issues
because the Standard Schema contract requires a `message` string. Formatting `--diagnostic-only`
issues is available separately from `@mizchi/jsimd-validator/debug` and is intended for
debug/logging boundaries.

Zod and other schemas exposing Standard JSON Schema can be passed directly. `compileSchemaAsync()`
and the CLI additionally accept Valibot Standard Schema directly through the official adapter.
`compileSchema()` remains synchronous for raw JSON Schema and Standard JSON Schema sources. Source
libraries are used only while running the compiler and are absent from generated code.

## Strict acceptance boundary

The compiler never silently approximates unsupported validation or output semantics.

- every JSON Schema keyword is checked against an allowlist
- both Standard JSON Schema `input()` and `output()` are converted and must normalize to the same IR
- hidden Zod custom/refine, overwrite, coercion, transform, default, root optional, and
  readonly-like schema types are rejected
- Valibot conversion errors are surfaced as `UnsupportedSchemaError`; stripping `object()`,
  defaults, root optional, transforms, custom checks, and async schemas are rejected
- no source `validate()` function is called during compilation

Use Zod `strictObject()` for rejecting unknown keys. For Valibot, use `strictObject()` to reject or
`looseObject()` to preserve unknown keys; stripping `object()` is outside this identity-validation
contract.

A complete checked-in example is available at
[`examples/validator-compiler-zod`](../../examples/validator-compiler-zod/README.md). It compiles a
nested Zod schema, type-checks a consumer against the generated declaration, and executes both raw
and Standard Schema validation paths.

The separate
[`examples/validator-compiler-zod-wasm`](../../examples/validator-compiler-zod-wasm/README.md)
compiles a strict 32-field Zod numeric object into an actual `.wasm` module plus JavaScript and
TypeScript glue.

## Wasm SIMD AOT internals and performance

Wasm cannot inspect arbitrary JavaScript objects directly. This backend therefore uses generated
glue for exact object-shape and `typeof number` checks, then passes number fields as Wasm
parameters. The compiler groups fields by inclusive/exclusive comparison mode, packs two independent
conditions into each `f64x2`, and reuses one vector local for the lower and upper comparisons.

The accepted Wasm subset is intentionally narrow:

- recursive strict objects with at most 256 fields per object
- 8–256 statically addressable finite `number` or `integer` leaves
- additional required strings with a finite `maxLength`
- homogeneous arrays with finite `maxItems`
- fixed-length array numeric leaves are unrolled into SIMD inputs
- inclusive or exclusive minimum/maximum constraints
- boolean-only output

Optional, unbounded-string, unbounded-array, union, loose-object, parser, and diagnostic schemas are
rejected at generation time. Integer, string, nested shape, and variable-length array checks use
scalar glue guards before statically addressable numeric range predicates enter the SIMD module. A
previous prototype that allocated and populated a flat numeric array on every validation was
1.2–2.2x slower than a JavaScript loop at 8–128 elements. The public backend instead emits direct
property/index reads as a zero-allocation Wasm argument list.

For 32 or more fields, the glue first compares `Object.keys` with the schema-order key array. A
matching record skips general membership checks. A different order falls back to a `Set`, retaining
exact unknown-key, non-enumerable required-property, and inherited-property semantics. Schemas below
32 fields keep the smaller switch implementation.

Measured on 2026-09-01 with Deno 2.6.4 / V8 14.2 / Apple M5, using the same Wasm binary on both
sides:

|            fields / path | legacy switch glue | ordered + Set glue | speedup |
| -----------------------: | -----------------: | -----------------: | ------: |
|               32 / valid |           133.9 ns |            72.0 ns |   1.86x |
|    32 / first-field fail |           118.5 ns |            84.9 ns |   1.40x |
|     32 / last-field fail |           284.9 ns |           164.7 ns |   1.73x |
|               64 / valid |           776.4 ns |           301.3 ns |   2.58x |
|    64 / first-field fail |            20.7 ns |            20.2 ns |   1.03x |
|     64 / last-field fail |           710.2 ns |           258.6 ns |   2.75x |
|      64 / reversed valid |           783.0 ns |           645.0 ns |   1.21x |
|  64 / same-count unknown |             1.5 µs |             1.5 µs |   1.03x |
|              128 / valid |             2.9 µs |           531.1 ns |   5.46x |
|   128 / first-field fail |            14.9 ns |            15.9 ns |   0.94x |
|    128 / last-field fail |             2.5 µs |           464.6 ns |   5.49x |
|     128 / reversed valid |             2.9 µs |             1.2 µs |   2.51x |
| 128 / same-count unknown |             4.4 µs |             3.4 µs |   1.32x |

The ordered path therefore does not trade away fallback behavior to win the main benchmark. Run the
same-process comparison with:

```sh
just bench-validator-compiler-wasm
```

Caching every property in a generated local before the Wasm call was also tested and rejected. It
slowed the 64-field valid path from 106.5 to 112.1 ns and the 128-field path from 220.3 to 241.4 ns,
so direct property reads remain in the generated glue. A separate `typeof` guard is retained on the
first-field preflight so symbols and other non-numbers return `false` instead of being coerced.

A Wasm-internal early-return experiment folded comparisons in chunks of 8, 16, or 32 fields. It was
also rejected: branches made the valid path 14–24% slower, while skipping the remaining SIMD work
improved a second-field failure by only 3% at 64 fields and 8% at 128 fields. Middle failures were
at best 1–3% faster and late failures were unchanged or slower. The object-shape scan, type checks,
and JS-to-Wasm call dominate enough that branching inside the comparatively cheap SIMD predicate
does not pay for itself.

Expanding the JavaScript preflight to 2, 4, or 8 fields was tested separately. A combined two-field
guard made a second-field failure 17–34x faster, but repeated isolated runs exposed V8 optimization
instability: the final A/B made the 64-field valid path 9% slower and the 128-field path 42% slower.
Caching only those two values still regressed the 128-field valid path by 22% and the late-failure
path by up to 70%. The generated validator therefore retains one schema-ordered preflight field;
applications can place their highest-probability failure there without adding another hot-path
branch.

The plain JavaScript AOT backend now applies the ordered-key strategy to strict objects with at
least 128 declared fields. Its previous unknown-key loop compared every enumerable input key with
every schema key. The current same-process run improved schema-order valid input by 1.65x, reversed
valid input by 1.35x, and an extra-key failure by 1.43x. Lower widths retain the compact comparison
chain because their Set fallback results were mixed.

For a 128-field strict numeric object, boolean source changed from 21,881 to 21,206 raw bytes, with
gzip increasing from 2,704 to 2,772 bytes. Diagnostic and Standard source each dropped by 2,847 raw
bytes because their unknown-key path also reuses the generated Set; diagnostic gzip dropped by 308
bytes and Standard gzip by 325 bytes. Declarations are unchanged.

The checked-in 32-field example emits 1,012 bytes of Wasm (338 bytes gzip), 3,355 bytes of glue (768
bytes gzip), and a 1,118-byte declaration.

### Cross-library comparison

The cross-library benchmark uses the same strict numeric object and boolean result for every
runtime. All implementations agree on valid inputs, inclusive bounds, early/late failures,
non-finite numbers, missing fields, and unknown fields. Schema construction and build-time AOT
compilation are outside the steady-state timings. Zod and Zod Mini use their public `safeParse`
paths, which construct diagnostic results on failure; jsimd Wasm, Valibot `is`, and ArkType `allows`
return booleans only, so invalid-path work is not identical.

Representative run measured on 2026-09-01 with Deno 2.6.4 / V8 14.2 / Apple M5 (a second process
reproduced Wasm's relative placement; absolute values were noisier for the largest JS validators):

|    fields / path |   JS AOT | Wasm SIMD | Zod compile | Zod Mini |  Valibot |  ArkType |
| ---------------: | -------: | --------: | ----------: | -------: | -------: | -------: |
|        8 / valid | 111.9 ns |   54.0 ns |     46.3 ns |  47.9 ns |   1.0 µs | 234.4 ns |
|   8 / early fail |  20.0 ns |   50.5 ns |     11.5 µs |  11.4 µs | 204.9 ns |  20.0 ns |
|    8 / late fail |  69.1 ns |   51.3 ns |     11.3 µs |  10.8 µs | 956.3 ns |  28.9 ns |
|       32 / valid | 559.6 ns |  114.1 ns |    191.5 ns | 206.6 ns |   4.6 µs |   1.5 µs |
|  32 / early fail |  30.9 ns |  109.9 ns |     13.7 µs |  14.1 µs | 175.4 ns |  52.4 ns |
|   32 / late fail | 384.5 ns |  116.5 ns |     12.3 µs |  14.8 µs |   3.0 µs | 459.8 ns |
|      128 / valid |   2.8 µs |  349.0 ns |     10.3 µs |  11.8 µs |  48.2 µs |  13.2 µs |
| 128 / early fail |  46.3 ns |   17.5 ns |     51.5 µs |  40.1 µs | 206.9 ns |  64.4 ns |
|  128 / late fail |   3.3 µs |  479.8 ns |     42.5 µs |  43.7 µs |  37.8 µs | 887.3 ns |

Wasm is the strongest valid-path option once the object is wide: at 128 fields it was 7.97x faster
than JS AOT, 29.64x faster than Zod compile, 138.20x faster than Valibot, and 37.78x faster than
ArkType in this run. The late-failure path was also 1.85x faster than ArkType. At 8 fields Zod
compile remained 1.17x faster; at 32 fields the ordered-key Wasm path was 1.68x faster than Zod
compile in this run.

At 32 fields the ordered-key path is used without scalar preflight. For 64 or more fields, generated
glue additionally performs a type-safe scalar range preflight on the first declared field.
Applications can therefore put a likely-invalid field first and construct valid records in schema
order. Compared with the legacy switch, the 64-field glue changed from 6,308 to 6,170 raw bytes and
from 1,059 to 1,134 gzip bytes; at 128 fields it changed from 12,181 to 11,726 raw bytes and from
1,762 to 1,852 gzip bytes. This saves source and JIT input while costing 75–90 gzip bytes. The Wasm
binary is unchanged.

Repeated warm construction measured 4.6–7.1 µs to compile and instantiate from bytes, or 2.2–3.9 µs
to instantiate an already compiled `WebAssembly.Module`. This is a lower bound rather than a
cold-start measurement because engines may cache repeated module compilation. Applications should
instantiate once and reuse the validator.

The production-size comparison uses esbuild 0.28.2 with browser ESM, ES2022, bundling, and minify.
Wasm gzip is kept as a separate response and added to JavaScript gzip; declarations are excluded
from runtime transfer size.

| 32-field runtime     | minified JS |    Wasm |     total |  gzip JS | gzip Wasm | gzip total |
| -------------------- | ----------: | ------: | --------: | -------: | --------: | ---------: |
| jsimd JavaScript AOT |     3.56 kB |       — |   3.56 kB |  0.76 kB |         — |    0.76 kB |
| jsimd Wasm SIMD AOT  |     2.46 kB | 1.01 kB |   3.47 kB |  0.67 kB |   0.33 kB |    1.00 kB |
| Zod compile          |    98.73 kB |       — |  98.73 kB | 28.50 kB |         — |   28.50 kB |
| Zod Mini compile     |    46.82 kB |       — |  46.82 kB | 13.84 kB |         — |   13.84 kB |
| Valibot is           |     3.87 kB |       — |   3.87 kB |  1.45 kB |         — |    1.45 kB |
| ArkType allows       |   153.52 kB |       — | 153.52 kB | 47.58 kB |         — |   47.58 kB |

The Wasm runtime is almost the same raw size as JS AOT, but two compressed assets make its transfer
size 0.24 kB (32%) larger. It is still 31% smaller than Valibot, 93% smaller than Zod Mini, 96%
smaller than Zod, and 98% smaller than ArkType in this fixture. The generated 1.12 kB declaration is
development-only, and the compiler package is build-time-only.

```sh
just bench-validator-compiler-wasm-libraries
just measure-validator-wasm-comparison
```

For the included strict `User` fixture, `--boolean-only` produces 0.66 kB minified-style source /
0.36 kB gzip. Raw diagnostics produce 1.71 kB / 0.60 kB gzip, or 1.93 kB / 0.67 kB with native
`parseJSON`. The self-contained Standard Schema formatting adapter produces 2.75 kB / 0.92 kB gzip.

## AOT size scaling

The schema-size matrix compiles ten patterns independently. Each cell below is raw source / gzip;
`.d.ts` is shown separately because it affects the published package but not browser runtime bytes.

| schema                   |     boolean JS |  diagnostic JS |     Standard JS | Standard `.d.ts` |
| ------------------------ | -------------: | -------------: | --------------: | ---------------: |
| boolean                  | 0.08 / 0.09 kB | 0.29 / 0.18 kB |  1.33 / 0.53 kB |   1.77 / 0.53 kB |
| bounded string           | 0.24 / 0.19 kB | 0.57 / 0.30 kB |  1.61 / 0.63 kB |   1.77 / 0.53 kB |
| bounded integer          | 0.10 / 0.10 kB | 0.51 / 0.27 kB |  1.55 / 0.60 kB |   1.77 / 0.53 kB |
| four-literal union       | 0.13 / 0.11 kB | 0.88 / 0.29 kB |  1.92 / 0.63 kB |   1.80 / 0.55 kB |
| bounded integer array    | 0.28 / 0.20 kB | 0.98 / 0.40 kB |  2.03 / 0.73 kB |   1.78 / 0.53 kB |
| flat object, 4 fields    | 0.84 / 0.38 kB | 2.25 / 0.67 kB |  3.29 / 1.00 kB |   1.90 / 0.56 kB |
| strict object, 6 fields  | 1.31 / 0.53 kB | 4.05 / 1.02 kB |  5.09 / 1.34 kB |   1.95 / 0.59 kB |
| nested object + array    | 1.23 / 0.46 kB | 3.35 / 0.83 kB |  4.39 / 1.16 kB |   2.02 / 0.59 kB |
| three-object union       | 1.47 / 0.45 kB | 3.92 / 0.81 kB |  4.96 / 1.13 kB |   1.93 / 0.56 kB |
| strict object, 16 fields | 2.71 / 0.61 kB | 9.71 / 1.35 kB | 10.76 / 1.69 kB |   2.24 / 0.61 kB |

Boolean-only gzip grows slowly because repeated field checks compress well: 16 strict fields remain
0.61 kB. Raw diagnostic source grows faster because every field needs a predicate and a path-aware
failure branch, although gzip reduces 9.71 kB source to 1.35 kB. The Standard adapter adds roughly
0.34–0.35 kB gzip over raw diagnostics across object-heavy shapes; consumers that format errors at a
debug boundary should prefer the diagnostic target.

```sh
just measure-validator-schema-sizes
```

The dedicated validator workflow runs this fast generation-only matrix with gzip ratchets of 0.65 kB
for boolean JS, 1.45 kB for diagnostic JS, 1.80 kB for Standard JS, and 0.65 kB for every
declaration file. Comparative microbenchmarks remain opt-in, so this check does not make normal CI
materially heavier.

## Supported subset

- JSON primitives, finite numbers, and integers
- `const`, primitive `enum`, and `anyOf`
- fixed object properties, `required`, and boolean `additionalProperties`
- homogeneous arrays
- inclusive/exclusive numeric ranges and string/array length ranges
- first raw issue as `code + args + path`, with an optional Standard Schema formatting adapter

Unsupported validation keywords fail compilation. Transforms, coercion, defaults, custom checks,
async validation, schema-valued `additionalProperties`, regex patterns, formats, references, and
exact `oneOf` semantics are not silently approximated.

## Validator-only measurements

The validator-only suite does not parse or stringify JSON. Its labeled corpus contains 2,500 JSON
value cases covering valid values, bounds, missing fields, wrong types, and early/late failures. On
that common semantic subset, AOT, the internal jsimd scalar reference, Zod, Valibot, and ArkType all
produced 0 false positives and 0 false negatives (100% precision and recall). JSON Schema-specific
behavior, including Unicode code-point string lengths, is covered separately by the compiler
contract tests.

Microbenchmarks measured on 2026-09-01 with Deno 2.6.4 / V8 14.2 / Apple M5:

| boolean operation         | valid item | early invalid | late invalid | 128 valid | 128, last invalid |
| ------------------------- | ---------: | ------------: | -----------: | --------: | ----------------: |
| jsimd AOT `is`            |    38.7 ns |       44.3 ns |      81.7 ns |   10.7 µs |            9.7 µs |
| jsimd internal scalar     |    55.3 ns |       48.9 ns |     119.8 ns |   27.6 µs |           16.8 µs |
| Zod `compile().safeParse` |    23.8 ns |       16.6 µs |      24.3 µs |    4.2 µs |           77.2 µs |
| Valibot `is`              |   867.9 ns |      268.4 ns |     918.6 ns |  115.1 µs |           89.3 µs |
| ArkType `allows`          |    31.2 ns |       22.2 ns |      26.6 ns |    4.1 µs |            2.8 µs |

For a late invalid item with normal diagnostic results, raw AOT `validate` took 172.4 ns (123.8 ns
in single-pass mode), the jsimd internal scalar reference 390.3 ns, Valibot abort-early `safeParse`
760.5 ns, ArkType invocation 8.4 µs, and Zod compiled `safeParse` 11.1 µs. The APIs do not construct
identical diagnostic trees; the comparison represents their documented public result paths rather
than equal work.

The current profile is therefore specific: AOT is about 1.1–2.6x faster than the closure
implementation across the listed boolean paths. It is 6.1–22.4x faster than Valibot's boolean path,
but ArkType remains about 1.2–3.5x faster and Zod's compiled valid path about 1.6–2.6x faster. AOT's
strongest result is inexpensive raw first-issue reporting.

The broader shape suite uses equivalent boolean paths and ASCII strings so all libraries share the
same labeled semantics:

| shape / path                       | jsimd AOT | internal scalar | Zod compile |  Valibot | ArkType |
| ---------------------------------- | --------: | --------------: | ----------: | -------: | ------: |
| bounded string / valid             |   21.8 ns |         13.5 ns |     14.2 ns |  67.9 ns | 13.0 ns |
| bounded string / early invalid     |    8.0 ns |         12.0 ns |     10.2 µs | 159.8 ns | 19.7 ns |
| bounded string / late invalid      |   36.1 ns |         14.2 ns |      9.8 µs | 102.2 ns | 10.3 ns |
| bounded integer array / valid      |   22.1 ns |         59.9 ns |     41.3 ns |   2.6 µs | 25.6 ns |
| bounded integer array / early fail |   12.8 ns |          8.7 ns |      8.6 µs | 128.1 ns |  8.0 ns |
| bounded integer array / late fail  |   15.7 ns |         45.3 ns |      7.4 µs |   2.3 µs | 45.4 ns |
| nested object / valid              |   83.2 ns |        170.0 ns |     31.8 ns |   1.3 µs | 23.9 ns |
| nested object / early fail         |   51.3 ns |         99.1 ns |     15.4 µs | 477.3 ns | 20.3 ns |
| nested object / late fail          |   60.1 ns |        120.1 ns |     10.6 µs |   1.1 µs | 19.6 ns |

The 32-element array is where AOT is strongest: it is 1.15x faster than ArkType and 1.86x faster
than Zod on valid input, while preserving inexpensive failure paths. It is not a general
nested-object winner: ArkType is 2.5–3.5x faster there, and Zod is 2.6x faster on the valid path.
For bounded strings, closure compilation remains competitive with Zod and ArkType. AOT preserves
JSON Schema Unicode code-point semantics, using an ASCII fast path and an exact surrogate fallback;
code-point cases remain in the compiler contract suite rather than the ASCII-only cross-library
corpus.

These results define the package as a low-level identity-validation subset, not a replacement for a
general schema language. Its optimized scope is boolean AOT, fixed JSON-like shapes, homogeneous
bounded arrays, primitive/range checks, and first-issue diagnostics. Typed-column SIMD belongs to
the separate runtime package. Transforms, coercion, rich refinements, recursive schemas,
regex/formats, and exhaustive diagnostic trees should remain in higher-level libraries which can
compile into this subset when applicable.

```sh
just test-validator-compiler
just bench-validator-only
```

By default `validate` first runs the fastest boolean predicate and only constructs an issue on
failure. `--single-pass-diagnostics` instead emits a validator that finds the first issue in one
pass. In the current fixture run it made the late-invalid diagnostic path about 39% faster, with a
roughly 15% cost on valid diagnostic calls. Boolean `is` is unchanged.

The programmatic equivalent of `--javascript --boolean-only` is
`compileSchema(source, { backend: "javascript", target: "boolean" })`. It exports only the `is` type
guard and removes unreachable predicates already fused into primitive unions. It cannot be combined
with `jsonParser` or single-pass diagnostics.

The programmatic equivalent of `--javascript --diagnostic-only` is
`compileSchema(source, { backend: "javascript", target: "diagnostic" })`. It exports `is` and raw
`validate`, can include `parseJSON`, and omits all formatter and Standard Schema adapter code. The
JavaScript `target: "standard"` additionally exports the formatted Standard Schema wrapper.

The Wasm SIMD backend is the package's default and primary optimized product. Unsupported Wasm
schemas are rejected instead of silently changing the backend. `--json-parser` belongs only to the
explicit `--javascript` backend and adds an experimental `parseJSON(string)` export. It deliberately
uses native `JSON.parse` followed by the generated validator: this is the parse+validation baseline
that a future schema-specialized UTF-8 Wasm parser must beat. The option is off by default, so
applications that do not parse JSON do not ship the parser wrapper.

## Abandoned fused JSON parser experiment

A schema-specialized parser prototype used the `@mizchi/jsimd/json` Wasm SIMD scanner to classify
UTF-8 token starts, then generated JavaScript functions constructed objects and arrays while
checking types, ranges, lengths, required properties, and unknown keys. Escaped string fragments
used native `JSON.parse` only for exact escape decoding; the complete document was not passed to
`JSON.parse`.

The prototype agreed with all ten AOT size-matrix shapes, but it was not a performance win:

| parse + validation         | single object | 128 objects |
| -------------------------- | ------------: | ----------: |
| native `JSON.parse` only   |        228 ns |     18.4 µs |
| native `JSON.parse` + AOT  |        256 ns |     21.3 µs |
| fused SIMD, UTF-8 bytes    |        1.9 µs |    214.7 µs |
| fused SIMD, string wrapper |        2.1 µs |    223.5 µs |

The token-position array, its Wasm-to-JavaScript copy, and JavaScript object reconstruction erased
the SIMD classification gain. The strict two-field fixture emitted 3.93 kB source / 1.43 kB gzip of
parser glue, plus the shared 479-byte / 290-byte gzip scanner Wasm. The scalar boolean artifact
remained 0.66 kB / 0.36 kB gzip.

The parser implementation, package subpath, CLI, optional peer dependency, and dedicated CI were
removed after this measurement. A streaming variant was considered but not implemented: streaming
would improve bounded memory and time-to-first-result for large inputs, but would not remove the
dominant JavaScript reconstruction cost when returning ordinary objects. This direction is paused;
only a future validation-only, fully in-Wasm, or resident-columnar design would justify reopening
it.
