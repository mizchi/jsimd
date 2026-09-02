# Pixel physics prototype plan

Status: Stage 0-4 scalar, active-block, row-major SIMD, active-SIMD, and off-thread active-SIMD
prototypes implemented on 2026-09-02. Nothing in this document is a public API or a package
admission decision.

## Current result

`pixel_block_sim.ts` implements the scalar reference and `?run=pixel&runtime=block` exposes it next
to the old pair solver. It alternates `(0, 0)` and `(1, 1)` partitions, swaps complete `u32` cells,
prevents a cell from moving twice in one tick, and derives every probabilistic choice from seed,
tick, and block coordinate. Empty/wall-only blocks and blocks completed by vertical movement skip
the random path.

The conformance suite exhaustively checks all 625 four-cell combinations of empty, wall, sand,
water, and gas, preserving metadata as well as material. It also covers deterministic replay,
single-move ownership, odd dimensions, boundary validation, gas rise, diagonal toppling, and seeded
lateral liquid movement. Shared scenarios now seal the complete perimeter with walls.

The first recorded Apple M5/Chrome comparison is in
[`benchmarks/pixel-block-scalar.json`](./benchmarks/pixel-block-scalar.json). At 25% full-world
occupancy, the block solver's complete-frame median was 13%, 17%, and 12% slower than the old pair
solver at 256 x 160, 512 x 320, and 1024 x 640 respectively. This satisfies the provisional 20%
scalar continuation gate; the 1024 x 640 p95 was 2.98 ms versus 2.96 ms. It remains an explicit
comparison runtime rather than an automatic default because only one browser/CPU has been recorded.
Its isolated lazy browser chunk is 1.02 KiB gzip and does not enter any UI-core entrypoint.

`pixel_block_active_sim.ts` reuses the same transition loop over active 32 x 32 chunk ranges, and
`?run=pixel&runtime=block-active` exposes it as a separate lazy backend. The block top-left owns the
update, preventing duplicate work at chunk borders. The full solver remains the oracle: a mixed
sand/water/gas fixture crossing chunk boundaries matches it exactly for 180 ticks and conserves all
complete cells. Empty worlds cool to zero scanned blocks; brushes wake a sleeping neighborhood.

The recorded 1024 x 640 locality run is in
[`benchmarks/pixel-block-active.json`](./benchmarks/pixel-block-active.json). At 25% occupancy,
active-block compute is 2.095 ms versus 2.010 ms for full block in the full region (+4.2%), 0.675 ms
versus 0.810 ms in quarter (1.20x faster), and 0.275 ms versus 0.480 ms in spot (1.75x faster).
After the 11-input tape, 576/640, 265/640, and 167/640 chunks respectively remain active. The
standalone active-block lazy entry is 1.94 KiB gzip under a 2.10 KiB ceiling; the full block entry
is 1.01 KiB gzip.

`pixel_block_step.wat` and `pixel_block_kernel.ts` implement the retained Stage 3 backend. Four
adjacent blocks are converted from two contiguous top-row loads and two bottom-row loads into
`a/b/c/d` SIMD lanes with byte shuffles. Density exchange, deterministic random generation, diagonal
toppling, lateral water/gas movement, moved masks, and inverse scatter all execute in `v128`; only
the zero-to-three row-tail blocks use scalar Wasm. The world remains row-major and resident, so
there is no per-tick transpose or JS/Wasm copy.

The conformance test matches JS cells and move counts for 160 ticks across odd dimensions and checks
complete metadata-cell conservation. After adding the Stage 4 range ABI, the kernel is 2,283 B raw /
1.14 KiB gzip and the full-SIMD lazy transfer is 2.33 KiB gzip. On Apple M5/Chrome at 25% full-world
occupancy, the original full-grid comparison recorded compute speedups of 2.67x, 3.28x, and 3.11x at
256 x 160, 512 x 320, and 1024 x 640; Canvas-inclusive speedups were 1.65x, 2.23x, and 2.12x. All
three p95 values improved. Versioned raw samples are in
[`benchmarks/pixel-block-row-major.json`](./benchmarks/pixel-block-row-major.json) and
[`benchmarks/pixel-block-simd-browser.json`](./benchmarks/pixel-block-simd-browser.json).

`pixel_block_active_kernel.ts` is the retained Stage 4 integration. The Wasm range ABI follows the
same half-open top-left ownership rule as the scalar active solver. It packs `hot` and `moves` into
one `i64`, so no per-move coordinate tape is materialized. The scheduler marks the owner chunk and
one-chunk halo for the next generation. Active SIMD matches full SIMD exactly for 180 ticks across
odd dimensions and chunk boundaries, and an idle world still cools to zero work.

At 1024 x 640 and 25% occupancy, 32 x 32 active SIMD costs 0.680 ms compute versus 0.590 ms for full
SIMD in the full region (+15%), but improves quarter from 0.575 to 0.335 ms (1.72x) and spot from
0.600 to 0.240 ms (2.50x). Canvas-inclusive speedups are 1.30x and 1.47x for quarter and spot. The
recorded result is
[`benchmarks/pixel-block-active-simd-browser.json`](./benchmarks/pixel-block-active-simd-browser.json).
A Chrome A/B rejected 24 x 24 chunks: its full, quarter, and spot compute medians were 0.845, 0.380,
and 0.270 ms, all slower than 32 x 32. The active SIMD lazy transfer is 3.61 KiB gzip including the
shared kernel, scheduler, adapter, and Wasm, under a 3.80 KiB gate.

`?run=pixel&runtime=worker-simd` moves that active-SIMD world and `ImageData` presentation into one
persistent Worker. Pointer listeners write fixed-width numeric records to `SharedArrayBuffer`; the
Worker reconstructs drag lines and owns the transferred `OffscreenCanvas`. Its input latency is
measured at `putImageData` completion using the main and Worker time origins, not when a later main
thread rAF polls statistics. At 1024 x 640, Worker SIMD adds only 8,368 B of explicitly owned
buffers over main-thread active SIMD and keeps tick-plus-presentation medians within noise.

With 8 ms of synthetic main-thread work per rAF, full-region main-frame work falls from 9.21 to
8.06 ms and spot falls from 8.76 to 8.07 ms. Input-to-Canvas-submit falls from 15.23 to 0.65 ms and
16.36 to 0.63 ms respectively because Worker input handling is no longer gated by the next main
rAF. The versioned no-load and load runs are
[`benchmarks/pixel-block-worker-simd-browser.json`](./benchmarks/pixel-block-worker-simd-browser.json)
and
[`benchmarks/pixel-block-worker-simd-load8-browser.json`](./benchmarks/pixel-block-worker-simd-load8-browser.json).

## Decision

Prototype a conservative pixel-physics engine as a separate, lazy experiment on top of Pixel Lab.
The first new solver will use staggered, non-overlapping 2 x 2 block updates (a Margolus-style
partition), not a general material scripting VM. The same logical transition contract must be
implementable by scalar JavaScript, Wasm SIMD, a persistent Worker, and resident WebGPU without
per-cell atomics.

The experiment is intended to answer these questions:

1. Does a 2 x 2 block rule reduce the directional artifacts of the existing vertical, diagonal, and
   horizontal pair passes while preserving material exactly?
2. Can one rule representation remain deterministic and equivalent across CPU and GPU backends?
3. Does Wasm SIMD help after accounting for the non-contiguous row-major 2 x 2 memory access?
4. At what active-area density do sleeping chunks repay their scheduler and halo cost?
5. Can simulation events needed by a UI or game remain compact enough that the world never needs a
   GPU-to-CPU readback each frame?

A useful result may be negative. In particular, the prototype must not assume that SIMD is faster:
Wasm SIMD has no general gather instruction, so packing several blocks can cost more than four
scalar loads unless storage or traversal is changed.

## Scope

The first prototype includes:

- empty, wall, sand, water, and one gas material;
- density exchange, lateral liquid spread, and seeded probabilistic toppling;
- exact material conservation for movement-only rules;
- deterministic replay from an initial world, seed, input tape, and tick count;
- active 32 x 32 chunks with a one-chunk wake halo;
- optional low-resolution temperature, pressure, and velocity fields after the block solver is
  validated;
- compact input and output event tapes; and
- Canvas or OffscreenCanvas presentation, with a GPU-resident render path for WebGPU.

The first prototype explicitly excludes:

- arbitrary user material scripts;
- rigid-body extraction, polygonization, and reinsertion;
- connected machines, wires, or long-range constraints;
- physically accurate stress, compaction, or granular contact; and
- DOM-node-per-cell rendering.

Those exclusions keep the experiment focused on the update representation. Rigid bodies are a later
solver coupled to the cell world, not another cell rule.

## Existing baseline

Pixel Lab currently owns a row-major `Uint32Array` with this stable experimental layout:

```text
bits  0..7   material
bits  8..15  temperature
bits 16..23  flags
bits 24..31  variant
```

Its scalar, active-chunk, Worker, and WebGPU paths use three disjoint pair passes. That
implementation is the control group and must remain runnable while the block solver is developed.
The new solver must not silently replace the recorded baseline.

At the experiment boundary, state and logic remain separate:

```ts
interface PixelWorldState {
  readonly width: number;
  readonly height: number;
  readonly cells: Uint32Array;
  readonly seed: number;
  readonly tick: number;
}

interface PixelStepBackend {
  step(state: PixelWorldState, events: PixelEventSink): PixelStepStats | Promise<PixelStepStats>;
}
```

This is a contract sketch, not the final TypeScript API. A GPU implementation may own opaque
resident buffers instead of exposing `cells`; conformance fixtures operate through explicit upload,
step, checksum, snapshot, and dispose operations.

## Block update contract

Each tick partitions the interior into non-overlapping 2 x 2 blocks. The partition origin alternates
between `(0, 0)` and `(1, 1)`. One invocation owns all four destination cells, so invocations cannot
race within a pass.

```text
phase 0                    phase 1

+----+----+----+           boundary shifted by one cell
| 2x2| 2x2| 2x2|              +----+----+
+----+----+----+           ----| 2x2| 2x2|
| 2x2| 2x2| 2x2|              +----+----+
+----+----+----+
```

The transition input is four complete `u32` cells plus tick, partition phase, and a deterministic
random word derived from `(seed, tick, blockX, blockY)`. Its output is four complete cells and zero
or more compact events. Movement transforms must preserve the multiset of complete cells. Reactions
must declare their material and energy balance separately so conservation failures cannot hide in
movement code.

World edges use an explicit wall boundary in every backend. GPU workgroups may round dispatches up,
but out-of-range blocks must be no-ops. Backend-specific randomness and floating-point state are not
allowed in the common movement rules.

The initial implementation should use readable rule functions. A table or generated decision tree is
considered only after profiling shows the branch structure to be a bottleneck. A central opcode VM
is out of scope because it would increase both bundle size and per-block dispatch cost.

## TDD sequence

Development follows exploration, Red, Green, and refactoring for each stage.

### Stage 0: conformance harness

Status: implemented for the scalar movement contract.

Write failing tests before the new solver:

- enumerate small movement-only block states and assert complete-cell multiset conservation;
- prove that one phase writes every owned cell at most once;
- cover odd widths, odd heights, one-cell dimensions, and explicit wall edges;
- replay the same seed and input tape twice and require identical checksums;
- verify that changing only the seed can change a probabilistic choice;
- retain a snapshot/debug path that reports the first differing cell; and
- define backend disposal and buffer-ownership tests before Workers or WebGPU are added.

### Stage 1: scalar reference

Status: implemented and exposed as `runtime=block`.

Implement the smallest readable 2 x 2 scalar solver. Add hourglass, reservoir, gas-rise,
mixed-density, and closed-container fixtures. Compare invariants rather than requiring the old pair
solver to produce the same visual result.

Measure directional bias by mirroring the same seeded scenario horizontally and vertically. Exact
per-tick mirror equality is not required for randomized rules, but long-run material distribution
and pile slopes must stay within a recorded tolerance.

### Stage 2: active chunks

Status: implemented and exposed as `runtime=block-active`.

Reuse the existing 32 x 32 activity representation, but align dirty ownership with block phases. A
chunk stays awake when it contains dynamic material, received an input, or borders such a chunk.
Keeping dynamic material hot is intentional: a probabilistic move rejected in the current two phases
may be accepted at a later tick, so cooling merely because no move occurred would diverge from the
full deterministic replay. Empty worlds reach zero active chunks, and painting wakes the brush chunk
and its required halo. A future material-specific stability proof could let immobile piles sleep
without changing this contract.

The full-grid scalar solver remains the oracle for localized scenarios. Compare final checksums when
the same deterministic rule is run with chunk sleeping disabled and enabled.

### Stage 3: Wasm SIMD

Status: retained as `runtime=block-simd`; the complete-step continuation gate passes on all three
sizes on the first recorded Apple M5/Chrome environment.

Benchmark before choosing layout:

- row-major scalar loads for one block;
- batching four or eight blocks with lane construction;
- a tiled/block-major scratch representation; and
- phase-specific row traversal that reuses loaded rows.

The rejected first attempt vectorized only vertical exchanges for two adjacent blocks. It beat the
Wasm scalar implementation but was 4-5% slower than JavaScript on the fixed tick-20 snapshot at 512
and 1024 widths. The retained implementation vectorizes all rules for four blocks. It uses row
shuffles instead of a packed scratch representation, so its measured `step()` already includes all
lane construction and scatter cost. The scalar path remains a fallback.

### Stage 4: Worker and Atomics

Status: implemented as `runtime=worker` for the scalar pair solver and `runtime=worker-simd` for the
active 2 x 2 Wasm SIMD solver.

The persistent Worker owns the world, chunks, and optional fields. Main-thread DOM listeners extract
only numeric pointer data into the existing coalesced slot and discrete SPSC ring. The main thread
never transfers an `Event` object or DOM node.

World cells are not made individually atomic. Atomics coordinate input, control state, completed
frames, and compact events. OffscreenCanvas is preferred when the surface is large enough to repay
handoff latency. Both backends reuse one Worker loop; only the simulation factory and palette are
split into lazy chunks. The seqlocked control block publishes compute/render timing and direct
input-to-Canvas-submit latency without transferring a world snapshot.

### Stage 5: resident WebGPU

Keep cells, optional fields, and rendering resident on the GPU. One compute invocation owns one 2 x
2 block. Rendering samples the resulting storage buffer directly. Do not map the world buffer per
frame.

CPU-visible results use a bounded event buffer and summary counters. Read them asynchronously and no
more frequently than needed by gameplay. Overflow is observable and drops low-priority events rather
than stalling the simulation.

### Stage 6: coupled coarse fields

Add temperature first, followed independently by pressure and velocity. Fields use their own lower
resolution, storage type, timestep, and active-tile policy. Cell rules sample the fields; field
solvers consume aggregated cell sources. Do not place `f32` pressure or velocity into every `u32`
material cell.

Each field is a separate lazy entrypoint so a falling-sand-only build does not pay for fluid or heat
logic.

## Event boundary

Simulation output needed by UI, audio, gameplay, or debugging is represented as fixed-width numeric
records, for example:

```text
PixelEvent: 16 bytes
  kind       u16
  material   u16
  x          u16
  y          u16
  value      u32
  tick       u32
```

Candidate events include reaction, contact, explosion, chunk-awake, and chunk-sleep. Rendering dirty
pixels is not an event; it stays within the owning renderer. High-volume debug traces are disabled
in benchmark and production-shaped builds.

The CPU/Worker path can publish events through a `SharedArrayBuffer` SPSC ring. The GPU path writes
an append buffer plus count and overflow flag, then copies only that compact prefix to a staging
buffer. A gameplay feature that requires the CPU to inspect most cells every tick is classified as a
CPU/Worker workload rather than forced onto WebGPU.

## Benchmark matrix

All backends run the same versioned initial worlds and input tapes.

| Axis             | Cases                                                                  |
| ---------------- | ---------------------------------------------------------------------- |
| world            | 256 x 160, 512 x 320, 1024 x 640, optional 2048 x 1280 stress          |
| occupancy        | 5%, 25%, 75%                                                           |
| locality         | full, quarter, spot, settled world with one moving source              |
| scenario         | hourglass, reservoir, mixed density, gas plume, reaction burst         |
| backend          | old pair scalar, block scalar, active block, Wasm SIMD, Worker, WebGPU |
| main-thread load | 0, 4, 8 ms per animation frame                                         |
| output           | no events, sparse events, event-buffer overflow stress                 |

Record raw samples and report:

- compute-only median and p95;
- complete tick-to-present median and p95;
- pointer-input-to-present median and p95;
- main-thread task time and animation-frame gap p95;
- active chunks and moved/changed cells;
- resident, peak, shared, and mapped/readback bytes;
- GPU synchronized time separately from presentation latency;
- event count, overflow count, and readback bytes;
- JavaScript gzip and raw/gzip Wasm or WGSL size; and
- deterministic checksum and material counts.

Warmup, browser version, adapter, runtime, sample count, seed, and scenario version are part of
every recorded JSON result. CPU and GPU results must not be compared using different presentation or
synchronization boundaries.

## Provisional continuation criteria

These are experiment gates, not release promises:

- all movement conservation, ownership, boundary, and deterministic replay tests pass;
- block scalar does not regress full-grid complete-step time by more than 20% unless it materially
  improves the recorded artifact metric;
- a SIMD path is retained only if it wins complete-step median by at least 1.25x on two sizes
  without a p95 regression greater than 10%;
- active chunks win by at least 1.5x when at most 25% of chunks are awake and do not regress a dense
  world by more than 20%;
- WebGPU is evaluated only as a resident simulate-and-render path and must report event readback
  separately;
- Worker selection must reduce main-thread work or frame-gap p95 under synthetic load; a lower
  compute time alone is not sufficient; and
- any automatic backend crossover is based on browser measurements from at least two adapters, not a
  constant inferred from one machine.

Failure keeps the backend as documented negative evidence or removes it from the demo selector; it
does not weaken the gate.

## Bundle and package boundary

Pixel physics remains under `experiments/ui-core-simd` and is loaded only by `?run=pixel`. It must
not be imported from `signals.ts`, `computed.ts`, `regions.ts`, or the Luna candidate entrypoint.
Existing core bundle ceilings must remain byte-for-byte enforceable.

Provisional isolated ceilings are:

| artifact                             |      ceiling |
| ------------------------------------ | -----------: |
| block solver and cell ABI JavaScript | 2,500 B gzip |
| complete active-block lazy entry     | 2,100 B gzip |
| optional event-tape JavaScript       | 1,000 B gzip |
| Wasm block kernel                    |  2,300 B raw |
| active-chunk addition                | 2,000 B gzip |
| WebGPU adapter and shader addition   | 4,500 B gzip |
| Worker client                        | 2,100 B gzip |
| scalar Worker                        | 5,450 B gzip |
| active-SIMD Worker + client + Wasm   | 9,000 B gzip |

Generated lookup tables do not enter JavaScript when they can live in Wasm data or GPU buffers. Each
optional field has a separate measured entrypoint. A backend that needs a large runtime or material
VM remains application code rather than becoming UI-core.

## References and implementation reading order

1. [Making Sandspiel](https://maxbittker.com/making-sandspiel/) and its
   [source](https://github.com/MaxBittker/sandspiel): browser-oriented `u32` cells, Rust/Wasm
   simulation, GPU wind, and direct texture presentation.
2. [Exploring the Tech and Design of Noita](https://www.gdcvault.com/play/1025695/Exploring-the-Tech-and-Design):
   chunked cellular material simulation coupled to rigid bodies and particles.
3. [Falling Turnip](https://github.com/tranma/falling-sand-game) and Gruau and Tromp's
   [Cellular Gravity](https://ir.cwi.nl/pub/1132): conservative block cellular automata and parallel
   falling-sand rules.
4. Devlin and Schuster,
   [Probabilistic Cellular Automata for Granular Media in Video Games](https://arxiv.org/abs/2008.06341):
   seeded probabilistic toppling and lattice-bias trade-offs.
5. [The Powder Toy](https://github.com/The-Powder-Toy/The-Powder-Toy): mature separation of material
   updates from air, pressure, heat, and gravity fields.
6. [Sands of Rust](https://github.com/wg-romank/sands-of-rust) and
   [Powder Sim](https://github.com/DeckardGer/Powder-Sim): WebGL/WebGPU block-update
   implementations.
7. Zhu and Bridson,
   [Animating Sand as a Fluid](https://www.cs.ubc.ca/~rbridson/docs/zhu-siggraph05-sandfluid.pdf): a
   continuum/particle alternative when physically based stress and friction matter more than
   per-pixel material rules.

References are design inputs, not code dependencies. Check each source license before adapting code;
prefer a clean implementation from the papers and the contract above.
