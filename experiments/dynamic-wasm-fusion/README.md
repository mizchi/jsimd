# Dynamic Wasm Fusion

This experiment compiles restricted element-wise `f32` expressions and shape-specialized GEMM plans
into fused Wasm SIMD kernels at runtime. The compiler emits the WebAssembly binary format directly.
It does not create WAT or invoke Binaryen, `wat2wasm`, or `wasm-tools` at runtime.

The goal is to find the break-even point where specialization and removal of intermediate arrays pay
for dynamic Wasm compilation. This is a kernel experiment, not yet a public `jsimd` API.

## Example

```ts
import { add, compileF32Map, constant, input, multiply, relu } from "./mod.ts";

// out[i] = relu(1.5 * a[i] - 0.5 * b[i] + 2)
const expression = relu(add(
  add(multiply(constant(1.5), input(0)), multiply(constant(-0.5), input(1))),
  constant(2),
));
const compiled = await compileF32Map(expression, 2);
const memory = new WebAssembly.Memory({ initial: 1 });
const kernel = await compiled.instantiate(memory);

kernel.run(aPointer, bPointer, outputPointer, length);
```

The call accepts scalar pointers and a length because `v128` values cannot cross the JavaScript /
Wasm boundary. Input and output buffers must reside in the imported `WebAssembly.Memory`. Output may
alias an input when the expression only reads the current element.

## Initial expression IR

| Operation         | SIMD instruction            |
| ----------------- | --------------------------- |
| input             | `v128.load`                 |
| constant          | `f32.const` + `f32x4.splat` |
| absolute          | `f32x4.abs`                 |
| add               | `f32x4.add`                 |
| multiply          | `f32x4.mul`                 |
| minimum / maximum | `f32x4.min` / `f32x4.max`   |
| output            | `v128.store`                |

Four values are evaluated per SIMD iteration. A scalar loop handles the final zero to three values.
Plans are validated and deterministically keyed before compilation, and identical plans share a
cached `WebAssembly.Module`.

## Shape-specialized GEMM

```ts
import { compileF32Gemm } from "./mod.ts";

const compiled = await compileF32Gemm({
  rows: 128,
  inner: 128,
  columns: 128,
  alpha: 1.25,
  beta: 0.5,
  bias: { kind: "columns" },
  activation: { kind: "relu" },
  rowTile: 2,
  multiplyAdd: "relaxed",
});
const kernel = await compiled.instantiate(memory);

// C = relu(1.25 * A*B + 0.5 * C + columnBias)
kernel.run(aPointer, bPointer, cPointer, columnBiasPointer);
```

A and C are tightly packed row-major `f32` arrays in the imported memory; B is row-major by default
or panel-major when requested. `C` is both the optional beta input and output. A shape is part of
the compilation key, so dimensions do not cross the JavaScript/Wasm boundary on each call.

The generated microkernel always holds eight `v128` accumulators. `rowTile` maps them to an MR x NR
output tile: `1x32`, `2x16`, `4x8`, or `8x4`. MR greater than one loads each B vector once and
reuses it across output rows. Remaining columns use a one-vector loop and then a scalar tail. Alpha,
beta, scalar or column bias, and ReLU or clamp are emitted into the store epilogue.

`multiplyAdd: "relaxed"` emits `f32x4.relaxed_madd`; it is opt-in because the engine may choose
fused or unfused rounding. `innerLoop` accepts `"loop"`, `"unroll2"`, `"unroll4"`, or `"unrolled"`.
All modes advance A/B pointer locals instead of recomputing matrix products in the K loop. Full
unrolling removes that loop but grows code linearly with K. The defaults remain the portable strict
operations, MR=1, and a compact runtime loop while the selection policy is experimental.

`compileF32GemmWithFallback()` probes the generated relaxed-SIMD opcode with
`WebAssembly.validate()` and resolves a requested relaxed plan to strict operations on unsupported
runtimes. It reports `effectiveMultiplyAdd`, so callers do not have to infer the numerical contract.

For a reused right-hand matrix, `packF32GemmRight()` converts row-major B into padded panel-major
storage and `rightLayout: "packed-panels"` compiles a kernel for that layout. The panel width
depends on `rowTile`, so the packed buffer must be created for the same plan used to compile the
kernel.

```ts
import { compileF32Gemm, packF32GemmRight } from "./mod.ts";

const plan = {
  rows: 128,
  inner: 128,
  columns: 128,
  rowTile: 4 as const,
  innerLoop: "unroll4" as const,
  rightLayout: "packed-panels" as const,
  columnBlock: 64,
};
const packedB = packF32GemmRight(plan, rowMajorB);
const compiled = await compileF32Gemm(plan);
```

## Benchmark

Run:

```sh
just bench-dynamic-wasm-fusion
```

The benchmark compares an optimized JavaScript fused loop, three resident generated Wasm passes, and
one resident generated fused Wasm pass. It also records binary size, cold compilation,
instantiation, first execution, and the estimated break-even call count. The checked-in baseline is
machine-specific and should be treated as a decision aid rather than a portable claim.

Apple M5, Deno 2.6.4, 1,048,579 `f32` values, 31 samples:

| Path                           |   Median | Relative to generated fused |
| ------------------------------ | -------: | --------------------------: |
| JavaScript fused single loop   | 0.634 ms |                3.76x slower |
| generated Wasm, three passes   | 0.377 ms |                2.24x slower |
| generated Wasm, one fused pass | 0.169 ms |                    baseline |

The emitted module is 246 bytes. Cold compilation took 3.17 ms and instantiation took 0.07 ms in
this run, producing an estimated seven-call break-even against the JavaScript loop at this input
size. See [`benchmarks/baseline.json`](./benchmarks/baseline.json) for samples and boundary notes.

### GEMM result

Run `just bench-dynamic-wasm-fusion-gemm`. Apple M5, Deno 2.6.4, square row-major matrices, 21
samples with eight operations per sample:

| Shape | JS block-4 fused | static generic Matrix2D | generated fused | vs JS | vs static |
| ----: | ---------------: | ----------------------: | --------------: | ----: | --------: |
|    16 |      0.005172 ms |             0.002688 ms |     0.002167 ms | 2.39x |     1.24x |
|    64 |      0.080234 ms |             0.030865 ms |     0.012276 ms | 6.54x |     2.51x |
|   128 |      0.650052 ms |             0.252693 ms |     0.098344 ms | 6.61x |     2.57x |
|   256 |      6.334609 ms |             2.490062 ms |     0.971396 ms | 6.52x |     2.56x |

The static row measures only `A*B`, while generated fused also applies alpha, column bias, and ReLU,
so the static comparison favors the baseline. The generated module is 1.19–1.21 KiB. Compilation
plus instantiation breaks even against JavaScript after about 773 calls at 16x16, six calls at
64x64, and one call at 128x128 or larger in this run.

The important result is specialization, not epilogue fusion alone. Compared with generated GEMM plus
a separate generated element-wise epilogue, fusion was only 0.98–1.03x. Keeping eight accumulators
live, using pointer induction, and reusing each A splat produced the larger gain over the existing
generic kernel. Raw samples are in [`benchmarks/gemm.json`](./benchmarks/gemm.json).

### Register-tile experiment

All variants retain eight vector accumulators, so this measures their shape rather than adding more
register state. Each table cell below comes from a fresh Deno/Node process or Chromium profile for
that one shape/tile candidate:

| Shape       | Deno 2.6.4 best | Node 24.12 best | Chromium best |
| ----------- | --------------: | --------------: | ------------: |
| 16x16x16    |     MR=4, 3.32x |     MR=2, 1.98x |   MR=1, 1.00x |
| 64x64x64    |     MR=4, 1.16x |     MR=1, 1.00x |   MR=1, 1.00x |
| 128x128x128 |     MR=2, 1.21x |     MR=1, 1.00x |   MR=1, 1.00x |
| 256x128x32  |     MR=2, 1.19x |     MR=1, 1.00x |   MR=1, 1.00x |
| 32x128x256  |     MR=2, 1.21x |     MR=1, 1.00x |   MR=1, 1.00x |

The 16x16 timings are sub-microsecond and are excluded from policy decisions. This Deno build
benefits from B reuse across rows, while the tested Node and Chromium builds consistently favor the
smaller MR=1 kernel. There is no runtime-independent tile policy; MR=1 remains the default, and any
future automatic selection needs runtime/version calibration rather than shape alone. Raw results
are in
[`benchmarks/gemm-row-tiles-isolated-deno.json`](./benchmarks/gemm-row-tiles-isolated-deno.json),
[`benchmarks/gemm-row-tiles-isolated-node.json`](./benchmarks/gemm-row-tiles-isolated-node.json),
and
[`benchmarks/gemm-row-tiles-isolated-chromium.json`](./benchmarks/gemm-row-tiles-isolated-chromium.json).

### Relaxed multiply-add experiment

With the best plausible MR from the tile experiment, relaxed multiply-add was consistently faster
and generated slightly smaller modules:

| Shape       |    Strict |   Relaxed | Speedup |
| ----------- | --------: | --------: | ------: |
| 64x64x64    | 0.0107 ms | 0.0092 ms |   1.16x |
| 128x128x128 | 0.0818 ms | 0.0682 ms |   1.20x |
| 256x128x32  | 0.0406 ms | 0.0347 ms |   1.17x |
| 32x128x256  | 0.0420 ms | 0.0356 ms |   1.18x |

This is worth retaining as an explicit feature tier, not as the default: relaxed SIMD permits
hardware-dependent rounding, and unsupported engines need a strict fallback. Raw data is in
[`benchmarks/gemm-relaxed-madd.json`](./benchmarks/gemm-relaxed-madd.json).

### Pointer induction and inner-loop unrolling

For a fixed 64xKx64 shape, all modes use A/B pointer locals. Bounded modes evaluate two or four K
steps per branch, while full unrolling removes the branch:

|   K | Factor 2 | Factor 4 |  Full | Factor-4 size | Full size |
| --: | -------: | -------: | ----: | ------------: | --------: |
|   4 |    1.54x |    1.75x | 4.09x |       3.3 KiB |   3.0 KiB |
|   8 |    1.11x |    1.15x | 1.20x |       3.3 KiB |   4.9 KiB |
|  16 |    1.07x |    1.16x | 1.21x |       3.3 KiB |   8.6 KiB |
|  32 |    1.07x |    1.14x | 1.15x |       3.3 KiB |  15.9 KiB |
|  64 |    1.14x |    1.21x | 1.20x |       3.3 KiB |  31.0 KiB |
| 128 |    1.10x |    1.16x | 1.15x |       3.3 KiB |  62.2 KiB |

Factor four retains nearly all of the full-unroll gain and becomes slightly faster at K=64 and 128.
Its module stays near 3.3 KiB and repays cold compilation after about 33–92 calls there, versus
31–62 KiB and 500-plus calls for full unrolling. Full unrolling remains useful for very small, very
hot shapes; factor four is the general candidate pending browser measurements. See
[`benchmarks/gemm-inner-unroll.json`](./benchmarks/gemm-inner-unroll.json).

### Packed B panels

Packing B removes row-stride address calculation and makes each K x NR panel contiguous. The
resident compute result was neutral for small and medium matrices and became useful only when the
right-hand matrix exceeded cache in this run:

| Shape       |  B size | Resident speedup | Pack + compute / row-major | Break-even reuse |
| ----------- | ------: | ---------------: | -------------------------: | ---------------: |
| 64x64x64    |  16 KiB |            1.03x |               2.69x slower |               70 |
| 128x128x128 |  64 KiB |            0.99x |               1.73x slower |            never |
| 256x256x256 | 256 KiB |            1.05x |               1.29x slower |                7 |
| 32x256x1024 |   1 MiB |            1.01x |               3.67x slower |              473 |
| 16x512x4096 |   8 MiB |            1.19x |               6.94x slower |               39 |
| 512x256x32  |  32 KiB |            0.99x |               1.21x slower |            never |

The current JavaScript packer makes every one-shot case slower. Even the favorable 8 MiB case needs
about 39 computations with the same packed B to repay packing. A generated Wasm packer could reduce
that setup cost, but it cannot improve the small/medium resident ceiling by itself. KC/NC cache
blocking was therefore measured next. Raw data is in
[`benchmarks/gemm-packed-b.json`](./benchmarks/gemm-packed-b.json).

### NC cache blocking

`columnBlock` changes the generated loop order from `row tile → all B panels` to
`column block → row tile → panels`. It is available only with `rightLayout: "packed-panels"` and
must be a multiple of NR. This limits the resident B working set without introducing partial-C loads
and stores.

The extended-warmup Apple M5 / Deno 2.6.4 run found no material compute-side gain:

| Shape        | Packed B | Best NC | Best speedup |
| ------------ | -------: | ------: | -----------: |
| 256x256x256  |  256 KiB |       8 |        1.00x |
| 1024x256x256 |  256 KiB |      32 |        1.00x |
| 256x512x1024 |    2 MiB |    none |        1.00x |
| 16x512x4096  |    8 MiB |     128 |        1.01x |
| 64x2048x2048 |   16 MiB |      64 |        1.01x |

The result indicates that these kernels are not limited by repeatedly streaming B, even when B is 16
MiB. A KC split would add repeated partial-C traffic and more loop control without addressing a
measured bottleneck, so it is deferred until a workload demonstrates B-working-set pressure. The
blocked loop remains an experimental explicit option rather than an automatic plan choice. Raw data
is in [`benchmarks/gemm-cache-blocking.json`](./benchmarks/gemm-cache-blocking.json).

### Shared-B batch traversal

The next experiment gave NC blocking a more favorable reuse boundary. Independent A and C matrices
shared the same 8 or 16 MiB packed B. The baseline invoked the shape-specialized kernel once per
batch item; the batched variant flattened the batch into the row dimension, allowing one NC block to
remain active across every batch row.

|  Batch x MxKxN | Packed B | One batched call | NC within batch | Best total vs separate calls |
| -------------: | -------: | ---------------: | --------------: | ---------------------------: |
|  4x16x512x4096 |    8 MiB |            1.01x |           1.00x |                        1.01x |
| 16x16x512x4096 |    8 MiB |            1.02x |           1.00x |                        1.03x |
|  4x4x2048x2048 |   16 MiB |            0.87x |           1.16x |                        1.01x |
| 16x4x2048x2048 |   16 MiB |            1.01x |           1.00x |                        1.01x |

The apparent 1.16x NC gain at batch 4 only recovered a 0.87x regression from the unblocked flattened
loop order. Relative to the separate-call baseline, every best path remained within 1.01–1.03x.
Neither eliminating the calls nor retaining an NC panel across the batch materially changed the
resident boundary. This is additional evidence against implementing KC without a different measured
workload. Raw data is in
[`benchmarks/gemm-shared-b-batch.json`](./benchmarks/gemm-shared-b-batch.json).

## Optimization backlog

The current experiment follows the BLIS/Goto decomposition only as far as a register microkernel.
BLIS defines GEMM around packed MR x K and K x NR panels, while the cache-level algorithm adds MC,
NC, and KC blocking. The remaining experiments are ordered as follows:

1. Find a workload that demonstrates B-working-set pressure before adding KC splitting. NC=8–256
   changed resident compute by only 1.00–1.01x through a 16 MiB B matrix. Flattening shared-B
   batches so an NC panel survived across every batch row still produced only 1.01–1.03x end-to-end.
   KC would additionally introduce partial-C traffic.
   [Goto and van de Geijn](https://www.cs.utexas.edu/~flame/books/ACMTOMS.pdf) explain why packing,
   cache, and TLB behavior are central; the
   [BLIS kernel guide](https://github.com/flame/blis/blob/master/docs/KernelsHowTo.md) defines its
   MR/NR packed-panel contract.
2. Generate a Wasm packer and fuse packing with the first computation pass only if a later blocking
   experiment raises that resident ceiling enough to repay more implementation and binary size,
   following the [GEMMFIP](https://arxiv.org/abs/2302.08417) result that standalone packing can
   dominate small GEMM.
3. Repeat isolated tile calibration before adopting a runtime/version-specific selector. The first
   run chose MR=2 for medium Deno shapes but MR=1 for the same Node and Chromium shapes. The
   [Exo microkernel work](https://arxiv.org/abs/2310.17408) supports generated,
   architecture-specific schedules rather than one fixed kernel.
4. Add persistent-Worker partitioning only after single-core packing/blocking wins at sizes large
   enough to repay Worker barriers.

## Compiler lifetime and bundle size

Generated modules are retained by an LRU owned by a compiler instance. The default limit is 64 map
modules and 64 GEMM modules. Applications with dynamic user plans should create an explicit owner so
the cache can be bounded more tightly or cleared with the application lifetime:

```ts
import { createDynamicWasmFusionCompiler } from "./mod.ts";

const compiler = createDynamicWasmFusionCompiler({
  maxMapModules: 16,
  maxGemmModules: 8,
});

await compiler.compileMap(expression, 2);
compiler.clearCache();
```

Complete K unrolling is limited to K <= 256. `unroll2` and `unroll4` remain available for larger K
because they keep generated code size bounded.

The compiler contracts are split into `map.ts` and `gemm.ts`; `mod.ts` is only the combined facade.
With esbuild minification and gzip -9 on Apple M5, the recorded source payloads are:

| Entry     | Minified JS | gzip JS | Runtime Wasm asset  |
| :-------- | ----------: | ------: | :------------------ |
| `map.ts`  |      6.7 kB | 2.28 kB | generated on demand |
| `gemm.ts` |     15.3 kB | 4.30 kB | generated on demand |
| `mod.ts`  |     20.8 kB | 5.48 kB | generated on demand |

These entries must remain separate if the experiment becomes package subpaths. Importing the map
compiler must not retain the GEMM emitter.

## Adoption decision

The direct-binary technique is worth adopting, but not as one automatic BLAS replacement.

| Scope                                     | Decision                                   | Reason                                                                                                                                   |
| :---------------------------------------- | :----------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------- |
| restricted element-wise `f32` map fusion  | adopt as an opt-in experimental subpath    | 3.76x resident speedup at 1,048,579 values, about seven calls to repay cold compilation, and 2.28 kB gzip compiler code                  |
| shape-specialized GEMM microkernel        | retain as an experimental opt-in candidate | 6.52–6.61x over the recorded JavaScript loop and 2.51–2.57x over generic Matrix2D, but shape/runtime-specific scheduling remains visible |
| relaxed FMA                               | expose explicitly with strict fallback     | 1.16–1.20x measured gain; rounding is not deterministic across implementations                                                           |
| bounded K unrolling and pointer induction | keep                                       | consistent inner-loop gain without unbounded code generation                                                                             |
| full K unrolling                          | explicit only, K <= 256                    | larger modules did not improve the large-K result                                                                                        |
| packed B                                  | explicit only                              | resident gain reaches 1.19x only at 8 MiB and JavaScript packing needs 39 reuses there                                                   |
| MR > 1 runtime selection                  | do not automate                            | Deno favored MR=2 while Node and Chromium favored MR=1                                                                                   |
| NC/KC cache blocking                      | do not adopt automatically                 | NC and shared-B batch traversal improved the complete boundary by at most 1.03x; KC has no measured justification                        |
| generated packer or persistent Workers    | do not implement yet                       | neither can repay itself before a single-core packed/blocking workload wins                                                              |

Accordingly, the element-wise compiler is the only part ready to move toward a public experimental
`jsimd` subpath. GEMM should remain in `experiments/` until the same explicit plan wins in Node,
Deno, and Chromium and a real consumer supplies stable shapes with enough reuse. The emitter, binary
encoding, cache, and feature detection remain implementation details rather than public low-level
APIs.

Dynamic compilation also requires `WebAssembly.compile()` permission. A CSP that denies dynamic Wasm
compilation cannot use an arbitrary expression compiler, and there is no finite prebuilt Wasm
fallback for arbitrary expression trees. A future public subpath must report this capability clearly
and let the application choose a predeclared static kernel or JavaScript fallback; it must not imply
that every browser sandbox is supported.

The relaxed FMA opcode and its non-deterministic rounding contract come from the official
[WebAssembly Relaxed SIMD proposal](https://github.com/WebAssembly/relaxed-simd/blob/main/proposals/relaxed-simd/Overview.md).

## Trade-offs

- Fusion is most useful for large resident arrays and repeated execution. Small arrays can be slower
  because a JavaScript/Wasm call and dynamic compilation are fixed costs.
- A fused pass reduces memory traffic; it does not automatically beat a well-optimized JavaScript
  loop when the expression is already simple and memory-bound.
- The current GEMM has no KC split, batched path, or thread-parallel path. Packed panels and NC
  blocking are opt-in, and panels are currently packed by JavaScript. It is not a replacement for a
  complete BLAS.
- Every GEMM shape and epilogue combination creates a separate cached module. The LRU bounds
  retention, but highly dynamic shapes can still spend more time compiling than a generic kernel.
- Wasm compilation can be blocked by Content Security Policy unless `wasm-unsafe-eval` is allowed. A
  production application therefore needs its own predeclared static-kernel or JavaScript fallback.
- The default cache is process-local and bounded by module count. Long-lived applications with many
  user-generated plans should create an explicit compiler owner, lower its limits, and clear it with
  the application lifetime.
- Core SIMD does not guarantee fused multiply-add. The experimental relaxed tier may change rounding
  behavior; the portable compiler path proactively validates support and reports a strict fallback.

The binary encodings follow the
[WebAssembly SIMD binary specification](https://github.com/WebAssembly/simd/blob/main/proposals/simd/BinarySIMD.md).
Runtime compilation uses the standard
[`WebAssembly.compile()` JavaScript API](https://webassembly.github.io/spec/js-api/), and CSP
behavior is defined by
[`wasm-unsafe-eval`](https://www.w3.org/TR/CSP/#directive-script-src-wasm-unsafe-eval).
