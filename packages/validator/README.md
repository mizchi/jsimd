# `@mizchi/jsimd-validator`

Small Wasm SIMD validator for typed numeric arrays. It scans homogeneous numeric columns for finite
values and inclusive range violations, returning either a boolean or the first invalid index.

Use [`@mizchi/jsimd-validator-compiler`](../validator-compiler/README.md) when the input is a
JSON-like object and its schema is known at build time.

## Install

```sh
pnpm add @mizchi/jsimd-validator
```

Node.js 24 or newer is required.

## Quick start

Import a typed-array schema, add inclusive bounds, and compile its SIMD validator once:

```ts
import { compileSimd, int32Array, maxValue, minValue } from "@mizchi/jsimd-validator";

const Ages = await compileSimd(
  int32Array(minValue(0), maxValue(130)),
);

Ages.is(new Int32Array([18, 36, 130])); // true
Ages.firstInvalid(new Int32Array([18, 131])); // 1

const result = Ages.safeParse(new Int32Array([18, 131]));
// {
//   success: false,
//   issues: [{ code: "max_value", args: [130], path: [1] }],
// }
```

`compileSimd()` asynchronously instantiates the Wasm kernel. Create the validator outside the hot
path and reuse it for every compatible input.

## Public API

Array schemas:

- `int32Array(...actions)` for `Int32Array`
- `uint32Array(...actions)` for `Uint32Array`
- `uint8Array(...actions)` for `Uint8Array`
- `float32Array(...actions)` for `Float32Array`
- `float64Array(...actions)` for `Float64Array`

Actions:

- `minValue(number)` sets an inclusive lower bound
- `maxValue(number)` sets an inclusive upper bound

Both actions require finite bounds. Invalid actions and unsupported values throw during schema
construction instead of being approximated.

Each compiled validator exposes:

```ts
interface SimdValidator<Output extends TypedArray> {
  is(input: unknown): input is Output;
  firstInvalid(input: Output): number;
  safeParse(input: unknown):
    | { success: true; output: Output }
    | { success: false; issues: readonly [Issue] };
  resident(length: number): ResidentInput<Output>;
}
```

`firstInvalid()` returns `-1` when every element is valid. It throws when passed a different
typed-array class; use `is()` or `safeParse()` for unknown input.

## Resident input

Normal validation copies the source typed array into Wasm memory before scanning it. For repeated
work on large columns, create a resident input and write directly into its Wasm-backed view:

```ts
import { compileSimd, float32Array, maxValue, minValue } from "@mizchi/jsimd-validator";

const Values = await compileSimd(
  float32Array(minValue(0), maxValue(1)),
);
const resident = Values.resident(1_000_000);

resident.input.set(source);
resident.is();
resident.firstInvalid();
resident.safeParse();
```

Growing the validator's Wasm memory detaches older resident views. Calling an older resident handle
then throws explicitly; create resident buffers after establishing the required capacities.

## Diagnostics

`safeParse()` returns one lightweight issue for the first invalid element. Issues contain an
enum-like `code`, positional `args`, and `path` rather than a formatted message:

```ts
type Issue =
  | { code: "type"; args: readonly [expected: string]; path: readonly [] }
  | { code: "min_value"; args: readonly [minimum: number]; path: readonly [number] }
  | { code: "max_value"; args: readonly [maximum: number]; path: readonly [number] };
```

Load message formatting only in a debug or logging path:

```ts
import { formatIssue } from "@mizchi/jsimd-validator/debug";

const result = Ages.safeParse(new Int32Array([131]));
if (!result.success) {
  console.error(formatIssue(result.issues[0]));
}
```

The debug entry point also exports `formatIssueMessage()` and `formatIssues()`.

## IEEE 754 behavior

`Float32Array` and `Float64Array` validation accepts finite IEEE 754 values:

- signed zero and subnormal values are accepted
- `NaN`, `Infinity`, and `-Infinity` are rejected
- float32 bounds are rounded toward the valid interval in binary32

This preserves direct JavaScript comparison semantics after a number is stored in a `Float32Array`:

```ts
const Probability = await compileSimd(
  float32Array(maxValue(0.1)),
);
const input = new Float32Array([0.1]);

input[0] > 0.1; // true after binary32 rounding
Probability.is(input); // false
```

## SIMD execution

Each array kind uses a dedicated 128-bit Wasm SIMD scan and a scalar tail. The kernel preserves the
first invalid index, so `is()`, `firstInvalid()`, and `safeParse()` share the same validation
semantics.

Copy-inclusive validation is convenient for ordinary typed arrays. Resident validation removes the
copy when the producer can write into the Wasm-backed view.

## Scope

This package is a low-level column validator, not a general object-schema library. It supports:

- `Int32Array`, `Uint32Array`, `Uint8Array`, `Float32Array`, and `Float64Array`
- inclusive minimum and maximum constraints
- finite-float validation
- first-invalid-index reporting
- copy-inclusive and resident validation

It does not accept objects, strings, heterogeneous arrays, unions, transforms, coercion, custom
refinements, or asynchronous validation. For strict JSON-like object schemas, compile a standalone
validator with `@mizchi/jsimd-validator-compiler`.

Short arrays may be faster with a JavaScript loop because the Wasm call and input copy dominate the
scan. This package is aimed at columns with roughly 1,024 or more elements, or data written directly
into resident Wasm memory.

## Performance

The following full-scan measurements place an invalid value at the final element. They were
collected with Deno 2.6.4, V8 14.2, and Apple M5. Lower is better.

| Kind | Elements | JavaScript scalar | SIMD, copy included | SIMD, resident |
| ---- | -------: | ----------------: | ------------------: | -------------: |
| i32  |       32 |           35.8 ns |             86.9 ns |        55.5 ns |
| i32  |    1,024 |            1.1 us |            462.6 ns |       433.1 ns |
| i32  |   65,536 |          103.1 us |             30.1 us |        20.5 us |
| f32  |       32 |           65.6 ns |            124.7 ns |        73.5 ns |
| f32  |    1,024 |            1.9 us |            518.0 ns |       429.0 ns |
| f32  |   65,536 |          121.2 us |             28.2 us |        20.7 us |
| f64  |       32 |           67.2 ns |            131.0 ns |        69.8 ns |
| f64  |    1,024 |            2.0 us |            718.5 ns |       560.0 ns |
| f64  |   65,536 |          128.5 us |             44.2 us |        28.5 us |

These values describe one machine and runtime, not a cross-runtime guarantee. Run the repository
benchmark on the deployment target:

```sh
just test-validator
just measure-validator-bundles
```

## License

MIT
