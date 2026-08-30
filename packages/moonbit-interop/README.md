# `@mizchi/jsimd-moonbit-interop`

JavaScript adapters for MoonBit's JS backend. The package understands the runtime representations of
`Bytes`, `BytesView`, `StringView`, and `ArrayView[Byte]` without materializing whole views.

```moonbit
#module("@mizchi/jsimd-moonbit-interop")
extern "js" fn find_byte(input : Bytes, needle : Byte) -> Int = "findByte"
```

The root export preserves the MoonBit `Bytes` / `BytesView` contracts and delegates hot paths to the
prebuilt WebAssembly SIMD kernels in `@mizchi/jsimd/bytes`. It exports `find`, `findByte`,
`revFind`, `revFindByte`, `findNonAscii`, `equal`, and shortlex `compare`.

`@mizchi/jsimd-moonbit-interop/string-view` exports UTF-16-relative `stringViewFind`,
`stringViewRevFind`, `stringViewFindCodeUnit`, `stringViewRevFindCodeUnit`, and shortlex
`stringViewCompare`. These call the JavaScript engine's native string operations and do not load the
Wasm byte kernels.

`@mizchi/jsimd-moonbit-interop/array-view` exports byte-specialized `arrayViewFindByte`,
`arrayViewRevFindByte`, `arrayViewFind`, and `arrayViewRevFind`. These operate directly on the
MoonBit ArrayView bounds through native JavaScript array searches. `FixedArray` is intentionally not
exposed: converting its generic JS Array representation into Wasm memory was slower than the native
path.

All search functions return `-1` for a miss so MoonBit facades can convert the result to `Int?`
without exposing JavaScript values.
