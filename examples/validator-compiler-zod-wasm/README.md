# Zod subset to schema-specialized Wasm

Zod の strict な wide numeric object を build-time に解析し、スキーマ固有の Wasm SIMD predicate
と最小 JavaScript/TypeScript glue を生成する example です。

これは`@mizchi/jsimd-validator-compiler`の主機能を示すexampleです。packageを利用するprojectでは
Node.js 24以降でcompilerとschema sourceを開発依存として追加します。

```sh
pnpm add -D @mizchi/jsimd-validator-compiler zod
```

```sh
just build-validator-compiler-zod-wasm-example
just test-validator-compiler-zod-wasm-example
```

次のCLIをapplication buildより前に実行します。

```sh
pnpm exec jsimd-validator-compiler \
  examples/validator-compiler-zod-wasm/schema.ts#TelemetrySchema \
  --out examples/validator-compiler-zod-wasm/generated/telemetry
```

生成物は次の3ファイルです。

- `telemetry.wasm`: 事前解析済みの `f64x2` SIMD 境界検査
- `telemetry.js`: object shape/type guard と明示的な Wasm instantiation
- `telemetry.d.ts`: Zod schema から生成した `Output` と validator factory 型

Wasm backend は、通常の JavaScript 値を Wasm memory へコピーする方式ではありません。required numeric
field を Wasm parameters として直接渡すため、現時点では以下だけを受理します。

- `strictObject`
- required finite `number` / `integer` fields が8–256個
- optionalではない、`maxLength`付きのstring field
- inclusive/exclusive min/max
- boolean-only predicate

integerはcompiler付属の`u8` / `u16` / `u32` / `i8` / `i16` / `i32` helperまたは同等の JSON
Schemaで利用できます。stringはJS glueでUnicode code point長を検査し、数値fieldだけをWasm SIMDへ
渡します。nested strict objectと上限付きarrayも受理し、固定長arrayの数値leafはWasm引数へ展開します。
optional、上限なしstring/array、union、loose object、diagnosticsは近似せず生成時に拒否します。
