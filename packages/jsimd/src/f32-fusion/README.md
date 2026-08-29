# F32 Fusion

`@mizchi/jsimd/f32-fusion` compiles a restricted element-wise Float32 expression into one generated
WebAssembly SIMD pass. It emits the Wasm binary format directly at runtime; it does not ship a
static `.wasm` asset or invoke WAT, Binaryen, or `wasm-tools` in the application.

```ts
import {
  add,
  constant,
  createF32FusionCompiler,
  input,
  multiply,
  relu,
} from "@mizchi/jsimd/f32-fusion";

// output[i] = relu(1.5 * left[i] - 0.5 * right[i] + 2)
const expression = relu(add(
  add(multiply(constant(1.5), input(0)), multiply(constant(-0.5), input(1))),
  constant(2),
));

using compiler = createF32FusionCompiler({ maxModules: 16 });
const compiled = await compiler.compile(expression, 2);
const memory = new WebAssembly.Memory({ initial: 1 });
const kernel = await compiled.instantiate(memory);

kernel.run([leftPointer, rightPointer], outputPointer, length);
```

Input and output pointers address tightly packed Float32 values in the imported memory. Output may
alias an input because each expression reads only the current element. The kernel processes four
values per SIMD iteration and uses a scalar tail for the final zero to three values.

Declare the compiler with `using`. Its LRU retains at most 64 generated modules by default; disposal
clears the cache deterministically. `maxModules` can set a smaller application-specific bound.

## Expression contract

| builder                 | generated operation |
| :---------------------- | :------------------ |
| `input(index)`          | Float32 input lane  |
| `constant(value)`       | `f32x4.splat`       |
| `absolute(value)`       | `f32x4.abs`         |
| `add(left, right)`      | `f32x4.add`         |
| `multiply(left, right)` | `f32x4.mul`         |
| `minimum(left, right)`  | `f32x4.min`         |
| `maximum(left, right)`  | `f32x4.max`         |
| `relu(value)`           | `max(0, value)`     |

Plans accept one to eight inputs, at most 1,024 expression nodes, and a maximum depth of 64.
Constants must be finite. Plans with identical Float32 semantics reuse the same compiled module.

## Runtime and CSP

This subpath requires WebAssembly SIMD and permission to call `WebAssembly.compile()`. A browser CSP
which denies dynamic Wasm compilation cannot execute arbitrary expression trees. Check
`await supportsF32Fusion()` before selecting this path when the deployment policy is not known, and
keep a predeclared static kernel or JavaScript fallback in the application.

Compilation is asynchronous. Instantiated execution is synchronous and is intended for repeated
operations over arrays already resident in the imported memory. This API deliberately does not copy
ordinary `Float32Array` inputs on each call because that would hide the boundary cost and erase much
of the measured benefit.

## Performance and trade-offs

Recorded on Apple M5 / Deno 2.6.4 over 1,048,579 values:

| path                            |   median | relative     |
| :------------------------------ | -------: | :----------- |
| optimized JavaScript fused loop | 0.634 ms | 3.76x slower |
| three generated Wasm passes     | 0.377 ms | 2.24x slower |
| one generated fused Wasm pass   | 0.169 ms | baseline     |

The generated module was 246 bytes. Compile plus instantiate cost about 3.24 ms and was repaid after
approximately seven calls at this size. Small arrays, one-shot execution, inputs copied for every
call, or constantly changing expressions can be slower than JavaScript. The cache bounds retained
modules, but it cannot make compilation churn free.

Complete benchmark data and the rejected GEMM/cache-blocking extensions remain in
[`experiments/dynamic-wasm-fusion`](../../../../experiments/dynamic-wasm-fusion/README.md).

## Standalone build size

The isolated Vite fixture emits 9.40 kB minified JavaScript (3.34 kB gzip) and zero static Wasm
assets. The workspace build budget requires JavaScript to remain below 4.00 kB gzip and rejects any
static Wasm asset on this subpath.
