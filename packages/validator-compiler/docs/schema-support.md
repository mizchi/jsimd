# Supported schemas

`@mizchi/jsimd-validator-compiler` accepts built-in helper schemas, JSON Schema, and supported Zod
or Valibot schemas converted through Standard JSON Schema. Normalization is strict: unsupported
keywords and semantics produce `UnsupportedSchemaError`.

## Built-in helpers

The helper API constructs serializable JSON Schema objects:

```ts
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
```

Numeric helpers accept inclusive `min` and `max` options within their intrinsic ranges:

| Helper             | Accepted JavaScript values                    |
| ------------------ | --------------------------------------------- |
| `u8`, `u16`, `u32` | Integers in the corresponding unsigned range  |
| `i8`, `i16`, `i32` | Integers in the corresponding signed range    |
| `f32`              | Finite numbers in the IEEE 754 binary32 range |
| `f64`              | Finite JavaScript numbers                     |

`f32` does not require `value === Math.fround(value)`. Generated TypeScript fields are `number`;
width, integrality, and range remain runtime constraints.

Strings and arrays require an upper bound:

```ts
const Name = string({ minLength: 1, maxLength: 80 });
const Samples = array(f32({ min: -1, max: 1 }), {
  minLength: 16,
  maxLength: 16,
});
```

String length follows JSON Schema and counts Unicode code points. `strictObject()` may be nested.
Fixed-length arrays are flattened at compile time. Variable-length arrays use a bounded generated
JavaScript loop.

Unknown helper options, non-finite bounds, and invalid ranges throw immediately.

## JSON Schema subset

The normalization layer accepts:

- primitive types: `string`, finite `number`, `integer`, `boolean`, and `null`
- `const`, primitive `enum`, and `anyOf`
- objects with fixed `properties`, `required`, and boolean `additionalProperties`
- homogeneous arrays using `items`
- `minimum`, `maximum`, `exclusiveMinimum`, and `exclusiveMaximum`
- `minLength`, `maxLength`, `minItems`, and `maxItems`
- boolean schemas `true` and `false`

Metadata such as `$schema`, `$id`, `$comment`, `title`, and `description` is accepted and ignored.
Backend-specific restrictions apply after normalization.

The CLI accepts a JSON file directly:

```sh
pnpm exec jsimd-validator-compiler \
  ./packet.schema.json \
  --out ./generated/packet
```

## Zod

Zod schemas are read through their Standard JSON Schema interface:

```ts
import * as z from "zod";

const fields = Object.fromEntries(
  Array.from({ length: 32 }, (_, index) => [
    `value${index}`,
    z.number().min(index).max(index + 100),
  ]),
) as Record<string, z.ZodNumber>;

export const Telemetry = z.strictObject(fields);
```

Input and output JSON Schemas must normalize to the same representation. This rejects transforms
instead of dropping their semantics.

Supported Zod shapes within the JavaScript backend include primitives, arrays, strict or loose
objects, optionals used as object properties, nullable values, literals, enums, and unions. The Wasm
backend accepts only its stricter subset described in [Backends](./backends.md).

## Valibot

Valibot conversion uses its official JSON Schema adapter:

```sh
pnpm add -D valibot @valibot/to-json-schema
pnpm exec jsimd-validator-compiler \
  ./schema.ts#Telemetry \
  --out ./generated/telemetry
```

`@valibot/to-json-schema` is an optional build-time peer and is loaded only for Valibot schemas. Use
`strictObject()` or `looseObject()` because stripping `object()` semantics cannot be preserved by an
identity validator.

## Rejected semantics

Compilation rejects semantics that cannot be represented without loss:

- transforms, coercion, defaults, custom refinements, and async validation
- regex patterns, formats, effects, records, tuples, maps, and sets
- recursive references
- exact-match `oneOf`
- schema-valued `additionalProperties`
- unsupported keywords or unknown helper options

Treat `UnsupportedSchemaError` as a build error and keep the source validator when the required
semantics exceed this subset.
