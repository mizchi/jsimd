# Pixel × Gear × Gel experiment

This prototype is intentionally isolated from the `ui-core-simd` browser comparison and is not a
published package or public API.

It explores three interactions:

- a rotating rigid gear displacing sand and water cells;
- high-viscosity material represented as a bonded aggregate with boundary-only steady-state work;
- local fracture and component rebuilding when accumulated contact stress exceeds bond strength.

## Architecture

The steady-state numerical kernel is written in Zig 0.16 and compiled to a small
`wasm32-freestanding` module with SIMD128 enabled:

- `zig/kernel.zig` contains only the exported pointer/scalar ABI;
- `zig/pixel_world.zig` owns the pixel-world step and its `u32x4` pair passes;
- `zig/gear.zig` owns gear geometry and particle displacement;
- `zig/gel.zig` owns four-lane boundary scans and SIMD crack-side classification;
- `kernel.ts` is the checked host-memory and Wasm ABI boundary;
- `gear.ts` only validates input and advances public state;
- `gel.ts` retains aggregate lifecycle and fracture connectivity in TypeScript, where maps and
  dynamically rebuilt components remain easier to maintain. The Zig kernel returns a byte side
  mask, so TypeScript no longer repeats the crack-plane math.

Gel boundary coordinates use structure-of-arrays storage so the Zig hot loop loads four `f32`
coordinates per vector. The pixel world itself is a `Uint32Array` view over imported Wasm memory.
Its vertical and horizontal disjoint-pair passes use `u32x4`, so neither world nor gear updates copy
the 512 × 320 cells across the host boundary each frame.

Run it with:

```sh
just dev-pixel-gear-experiment
```

Validate the isolated experiment with:

```sh
just test-pixel-gear-experiment
```

This runs Zig native tests, compiles with `-mcpu=baseline+simd128`, validates the module, asserts
that SIMD opcodes are present, rejects a SIMD-disabled validation pass, applies `wasm-opt -Oz`,
checks size budgets, builds the browser app, and runs the Deno integration tests. The pinned local
toolchain is Zig 0.16.0, wasm-tools 1.245.1, and Binaryen 116.

Run the isolated world-step benchmark with:

```sh
just bench-pixel-gear-experiment
```

On Apple M5 with Deno 2.9.6, the 256 × 160 steady-state workload measured 177.7 µs/step for the
TypeScript reference and 73.3 µs/step for Zig SIMD Wasm, a 2.42× speedup. The TypeScript version is
kept only as the differential correctness reference used by the integration test.

The experiment reuses `ui-core-simd/pixel_sim.ts` and `ui-core-simd/signals.ts`, but no gear or gel
entry point is reachable from the normal UI comparison build.

The current optimized Zig module is 11,420 bytes raw and 7,381 bytes with gzip. It is emitted as a
separate browser asset. Removing the TypeScript world step brings the combined JavaScript to
10,410 bytes with gzip, under the 10.7 kB experiment budget.
