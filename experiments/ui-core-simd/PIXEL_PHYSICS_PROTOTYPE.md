# Pixel physics prototype plan

Status: Stage 0-5, bounded WebGPU event readback, and CPU/Wasm/WebGPU temperature-reaction slices
of Stage 6 implemented on 2026-09-02. Nothing in this document is a public API or a package
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

`pixel_reaction_step.wat` adds a second resident Wasm pass for temperature and phase changes. It
uses the existing temperature byte in each `u32` cell, a separate full-size scratch generation,
four-neighbor integer diffusion, permanent fire sources, and water/gas vaporization thresholds.
The contiguous interior runs four cells per `i32x4`; borders and row tails stay scalar. Movement and
reaction kernels share one `WebAssembly.Memory`, so a tick does not copy the world through
JavaScript. Scalar and SIMD cells, complete metadata, event order, and overflow counts match for
small, odd, and SIMD-width worlds over repeated ticks.

`pixel_event_tape.ts` is a fixed 16-byte-record SPSC `SharedArrayBuffer` ring. The Worker emits
`kind/index/before/after`; the main thread can derive coordinates from the public width without
retaining an `Event`, object payload, or cell snapshot. Both the bounded Wasm event prefix and a
full SAB ring increment one observable dropped-event counter. ABI version 2 uses the final header
word for the newest non-empty publication timestamp, allowing the main consumer to measure
Worker-to-main event latency without growing a record. Its isolated implementation is 1,048 B gzip.
`?run=pixel&runtime=worker-reaction-simd` combines active 2 x 2 movement, dense thermal SIMD, compact
events, Atomics input, and OffscreenCanvas behind a dedicated lazy client/Worker pair.

`?run=pixel&runtime=block-webgpu` keeps the same conservative 2 x 2 movement state and rendering
resident on WebGPU. One invocation owns one disjoint block; no per-cell atomics or per-frame
readback are used. The explicit `readCells()` path is conformance-only. A browser check runs 48
ticks over an odd 63 x 41 world containing all materials and requires all 2,583 GPU cells to match
the scalar reference; it currently passes with zero mismatches.

An explicit, separately loaded WebGPU compute path can atomically append one fixed 16-byte record
per moved 2 x 2 block. It reuses a persistent bounded staging buffer and exposes total and dropped
counters. Twelve ticks over an odd 31 x 21 world match the scalar cells and all 944 block-event
records exactly; a capacity-two case also matches the expected 80 drops. The normal resident
renderer does not import this path and still performs no readback.

The first combined Apple M5/Chrome run is
[`benchmarks/pixel-reaction-webgpu-browser.json`](./benchmarks/pixel-reaction-webgpu-browser.json):

| grid       | backend              | compute median | tick/present median | input median | resident | events/drops |
| ---------- | -------------------- | -------------: | ------------------: | -----------: | -------: | -----------: |
| 256 x 160  | active Wasm SIMD     |       0.085 ms |            0.130 ms |     5.140 ms | 352 KiB  |          0/0 |
| 256 x 160  | reaction SIMD Worker |       0.245 ms |            0.310 ms |     0.240 ms | 556 KiB  |        299/0 |
| 256 x 160  | resident WebGPU      |              — |            0.910 ms |    17.260 ms | 160 KiB  |          0/0 |
| 1024 x 640 | active Wasm SIMD     |       0.825 ms |            1.365 ms |    15.695 ms | 5.00 MiB |          0/0 |
| 1024 x 640 | reaction SIMD Worker |       2.710 ms |            3.730 ms |     1.455 ms | 7.58 MiB |      2,282/0 |
| 1024 x 640 | resident WebGPU      |              — |            0.965 ms |    17.195 ms | 2.50 MiB |          0/0 |

These are different workloads: the reaction Worker performs a dense thermal pass and event
publication that the other two do not. WebGPU wins the large movement-and-render case but loses at
40,960 cells because queue synchronization dominates. The Worker is the usable path when
CPU-visible reactions and low main-thread work matter. The reported GPU tick includes
`queue.onSubmittedWorkDone`; it is not a submission-only number.

The changed-block readback stress run is in
[`benchmarks/pixel-block-webgpu-events.json`](./benchmarks/pixel-block-webgpu-events.json). At
1024 x 640 and 25% occupancy, a synchronized compute-plus-readback tick has a 0.310 ms median and
0.500 ms p95 while copying a fixed 4,112 B. It produces 9,980,582 events over 100 ticks, about
99,806 per tick; capacity 256 retains 25,600 and observably drops 9,954,982. This is useful as a
bounded diagnostic or dirty-block sample, but far too dense as a gameplay stream. A production GPU
path should append only semantic reaction/contact/explosion events or aggregated tile summaries.

That semantic path is now tested separately in
[`benchmarks/pixel-reaction-webgpu-events.json`](./benchmarks/pixel-reaction-webgpu-events.json).
It ping-pongs two GPU cell buffers through the same four-neighbor integer temperature diffusion as
the scalar and Wasm implementations and appends only vaporized/condensed records. An odd 19 x 11
conformance world matches all cells and 179 event records over 12 ticks; capacity two reports the
same 89 drops as the scalar oracle. Atomic append order is intentionally unspecified, so
conformance compares the event set by cell index and consumers must not use buffer order as causal
order.

The current reaction benchmark runs 400 ticks at 256 x 160, 512 x 320, and 1024 x 640 with capacity
256. Every-tick readback copies 4,112 B and awaits it. The batched mode accumulates four ticks and
keeps up to three 4,112 B staging maps in flight. Both modes match final Wasm cells and all 7, 33,
and 163 semantic events without drops. Triple staging costs a fixed 12,336 B; at 1024 x 640 the GPU
owns 5,247,008 B of resident state versus 5,308,416 B of rounded Wasm memory.

| grid       | Wasm wall/tick | WebGPU sync wall/tick | WebGPU batch-4 wall/tick | batch-4 completion median |
| ---------- | -------------: | --------------------: | -----------------------: | ------------------------: |
| 256 x 160  |       0.052 ms |              0.400 ms |                 0.045 ms |                  0.435 ms |
| 512 x 320  |       0.139 ms |              0.297 ms |                 0.042 ms |                  0.430 ms |
| 1024 x 640 |       0.615 ms |              0.398 ms |                 0.058 ms |                  0.475 ms |

The asynchronous numbers are throughput, not immediate event latency. Batch-4 makes events visible
up to three simulation ticks later, and its 1024 x 640 completion p95 is 1.835 ms. Main-thread CPU
submission remains about 0.005 ms median. An earlier short run observed one 41.93 ms GPU anomaly;
the 400-tick rerun did not reproduce it (2.360 ms maximum for batch-4), so more adapters and longer
tail runs remain necessary.

The dedicated Worker transport run is in
[`benchmarks/pixel-reaction-event-latency-browser.json`](./benchmarks/pixel-reaction-event-latency-browser.json).
With no synthetic main-thread load, the final observed age of the newest non-empty event batch is
15.635 ms at 256 x 160 and 9.075 ms at 1024 x 640; all 318 and 2,311 events arrive without drops.
These are rAF-polled snapshots rather than latency distributions, so they establish observability
and a frame-scale bound for this run, not a stable percentile claim.

## Current branch points

These are local Apple M5/Chrome observations, not portable automatic thresholds:

1. **Small dense reaction with immediate CPU visibility:** choose Wasm SIMD. At 40,960 and 163,840
   cells, every-tick synchronized WebGPU is 7.7x and 2.1x slower by wall throughput. WebGPU wins at
   655,360 cells by 1.55x. A straight-line fit through the 512 and 1024 widths crosses near 371,000
   cells, roughly 770 x 481, but the measured claim is only that the crossover lies between 163,840
   and 655,360 cells.
2. **Dense reaction where output may lag four ticks:** batched WebGPU wins throughput at all three
   sizes, but only by 1.15x at 40,960 cells. That small win is below the experiment's 1.25x retention
   bar and does not justify added latency or capability checks. From 163,840 cells it is 3.30x faster;
   at 655,360 cells it is 10.60x faster.
3. **Movement plus presentation:** existing results bracket the Wasm/WebGPU crossover between
   40,960 and 655,360 cells. A two-point linear fit is about 447,000 cells (846 x 529), close to but
   independent of the reaction crossover. Do not merge these thresholds: movement, Canvas upload,
   reaction, and readback have different costs.
4. **Sparse active area:** choose active-chunk Wasm/Worker even for a large allocation. At 1024 x
   640, active SIMD improves quarter and spot compute to 0.335 and 0.240 ms, while the current GPU
   reaction pass scans every cell. Allocated cell count alone is therefore insufficient; active
   density is a first-class selector.
5. **Main-thread contention or pointer responsiveness:** choose the Worker path when DOM/Canvas work
   would block input. With 8 ms synthetic main work, Worker input-to-submit stayed near 0.65 ms while
   the main path was about 15-16 ms. This can outweigh a slower simulation kernel.
6. **Output cardinality:** never read changed blocks as gameplay events. The dense block stream was
   about 99,806 events/tick and dropped 99.7% at capacity 256; the semantic reaction runs emitted at
   most 163 events over 400 ticks. GPU is viable only when output is semantic, aggregated, bounded,
   and allowed to arrive asynchronously.

The practical selector is therefore a tuple of `(allocated cells, active density, output
cardinality, visibility deadline, main-thread load, adapter)`, not one cell-count constant.

## Display sizing decision

The primary interactive path is the reaction SIMD Worker because semantic output must be visible
on the next main-thread poll; the four-tick WebGPU throughput mode is not an acceptable default.
The WebGPU implementations stay available as explicitly selected experiments.

Use `512 x 320` as the normal desktop simulation surface and `256 x 160` for narrow/mobile
surfaces. Target about `1.5-2 CSS px` per simulation cell and snap adaptive dimensions to 32-cell
chunk boundaries. At the current maximum desktop canvas width of about 894 CSS px, those presets
render at about 1.75 and 3.5 CSS px per cell respectively. A 1024-wide world renders below one CSS
pixel per cell in the same layout, so it is a stress/high-density mode rather than a useful default,
even though the Apple M5 result remains within the 120 Hz compute budget.

The dedicated 512 x 320 measurement is in
[`benchmarks/pixel-reaction-simd-sizing-browser.json`](./benchmarks/pixel-reaction-simd-sizing-browser.json).
At 25% full-world occupancy, reaction SIMD Worker tick-plus-presentation is 0.505 ms median / 0.845
ms p95, compute is 0.425 / 0.680 ms, and presentation is 0.080 / 0.160 ms. It owns 2,044,592 B,
records 0.18 ms input-to-Canvas submission, and publishes all 1,129 semantic events without drops.
The final rAF-polled event-batch age is 11.94 ms; it is not a latency distribution, but unlike the
WebGPU batch-4 path it does not intentionally defer visibility by simulation ticks.

For an adaptive production viewport, use the following policy before applying the 8:5 aspect
ratio: `width = floor(canvasCssWidth / targetCellCssPx / 32) * 32`, with
`targetCellCssPx = 2`, a 256-cell mobile floor, and a 512-cell normal cap. Raise the cap to 768 or
1024 only for a fullscreen/zoomable view and after recording slower target devices. Device pixel
ratio improves raster sharpness but does not make sub-CSS-pixel cells easier to inspect or paint,
so it is not used to reduce the interaction-size target.

## Material, rule, and buffer scaling

The reproducible Deno/Apple M5 result is in
[`benchmarks/pixel-rule-scaling.json`](./benchmarks/pixel-rule-scaling.json), produced by
`just bench-ui-pixel-rule-scaling`. The benchmark-only 302-byte Wasm kernel compares two material
dispatch shapes over the same u32 cells:

- a scalar direct lookup in a 256-byte property table; and
- a fused SIMD loop that applies one equality mask per known material to four cells.

This is a dispatch decision experiment, not a complete material-rule implementation. It shows the
cost of allowing the material count to lengthen a specialized comparison chain; neighbor reads and
actual rule bodies are deliberately excluded.

| materials | 512 table | 512 SIMD masks | 1024 table | 1024 SIMD masks |
| --------: | --------: | -------------: | ---------: | --------------: |
|         4 |  0.056 ms |       0.058 ms |   0.245 ms |        0.252 ms |
|         8 |  0.060 ms |       0.104 ms |   0.262 ms |        0.435 ms |
|        16 |  0.060 ms |       0.138 ms |   0.249 ms |        0.558 ms |
|        32 |  0.060 ms |       0.233 ms |   0.243 ms |        0.939 ms |
|        64 |  0.060 ms |       0.533 ms |   0.242 ms |        2.138 ms |
|       128 |  0.060 ms |       1.297 ms |   0.244 ms |        5.253 ms |
|       256 |  0.060 ms |       3.249 ms |   0.243 ms |       13.128 ms |

The direct table is effectively independent of material count and becomes the preferred generic
representation at eight materials in this model. Keep a few truly hot categories as masks if a
profile justifies them, but do not add one SIMD comparison for every material. The u32 cell ABI
already has an eight-bit material ID, so up to 256 material definitions do not enlarge the world.
A 16-byte descriptor costs only 1 KiB for 64 materials and 4 KiB for all 256.

Repeating the current complete temperature/reaction kernel models the conservative, unfused upper
bound for adding independent dense rule passes:

| dense passes/tick | 512 median / p95 | 1024 median / p95 |
| ----------------: | ----------------: | -----------------: |
|                 1 | 0.158 / 0.197 ms |  0.631 / 0.688 ms |
|                 2 | 0.316 / 0.359 ms |  1.281 / 1.383 ms |
|                 4 | 0.633 / 0.717 ms |  2.571 / 2.678 ms |
|                 8 | 1.287 / 1.563 ms |  5.135 / 5.329 ms |

The scaling is nearly linear. A "rule" must therefore not automatically mean a new world scan.
Rules that read the same neighborhood and fields should be fused into one generated pass; only
different synchronization boundaries or field topologies should create another pass. At 512 x
320, even eight dense-equivalent passes leave useful 60/120 Hz headroom. At 1024 x 640, eight
passes consume about 5.1 ms before movement, event transport, and presentation, making 120 Hz
fragile on this fast CPU.

`pixel_rule_scaling.ts` models explicitly owned buffers. The base 512 profile is 1.95 MiB. A
deliberately expanded profile with 64 materials, 32 descriptors, event capacity 2,048, a
double-buffered u8 field, a double-buffered u16 field, and a single-buffered u8 field is 3.13 MiB
at 512 x 320 and 12.00 MiB at 1024 x 640. The extra fields alone cost 1.094 and 4.375 MiB. Material
and rule descriptors together cost only 1.5 KiB; the three 16-byte event copies at capacity 2,048
cost about 96 KiB.

The resulting storage policy is:

1. Keep `material/temperature/flags/variant` in the existing u32 cell until a field truly needs an
   independent update topology.
2. Store material properties in direct SoA/AoS tables indexed by the eight-bit material ID.
3. Share one u32 scratch generation across sequential dense passes; do not allocate scratch per
   rule.
4. Use u8/u16 fields and double-buffer only fields that require old-generation reads.
5. Size the 16-byte semantic event ring as `peak events/tick x maximum consumer lag x headroom`,
   rounded to a power of two. For example, 100 events with one tick of lag and 1.5x headroom needs
   256 records; 600 events over two ticks needs 2,048.
6. Keep the fixed event record as `kind/index/arg0/arg1`. Rare variable payloads should use a
   separate bounded arena rather than enlarging every record or allocating JS objects.

The buffer totals exclude browser compositor memory, Canvas backing stores, allocator overhead,
and Worker isolate memory. Those remain browser-profiler measurements rather than ABI estimates.

### Implemented 12-material vocabulary

The first property-table implementation keeps the original six IDs and adds six common categories:

| material | movement/property role | implemented reaction                         |
| :------- | :--------------------- | :------------------------------------------- |
| stone    | immovable solid        | adjacent acid -> empty                       |
| wood     | immovable combustible  | heat/fire/lava -> fire; adjacent acid wins   |
| oil      | light liquid           | heat/fire/lava -> fire                       |
| smoke    | gas lighter than steam | fire adjacent to water -> smoke              |
| acid     | water-density liquid   | corrodes adjacent stone and wood             |
| lava     | heavy liquid           | permanent heat; adjacent water -> stone      |

Density, fluid, and movable properties fit in three `i8x16.swizzle` constants. Thus the SIMD
movement hot path performs one table shuffle per property instead of adding an equality mask per
material. Scalar code uses the same typed property contract. The 12-material local state space is
exhaustively checked for all 20,736 possible 2 x 2 blocks, and randomized odd-sized worlds compare
scalar and SIMD cells, move counts, metadata, hot-chunk state, reactions, and compact events.

The Apple M5/Deno result in
[`benchmarks/pixel-material-scaling.json`](./benchmarks/pixel-material-scaling.json) compares the
original vocabulary with a 25%-occupied 12-material world. Values are resident median milliseconds
per tick; each sample restores the same world and then runs 16 ticks.

| world      | move 6 | move 12 | reaction 6 | reaction 12 |
| :--------- | -----: | ------: | ---------: | ----------: |
| 256 x 160  |  0.070 |   0.063 |      0.142 |       0.116 |
| 512 x 320  |  0.245 |   0.271 |      0.523 |       0.519 |
| 1024 x 640 |  1.036 |   1.041 |      2.205 |       2.102 |

There is no monotonic 6-to-12 material penalty in this sample. The same fused instructions run for
both vocabularies, so scene composition and the number of emitted events dominate the difference.
The relevant cost is enabling four-neighbor chemistry at all: compared with the preceding
phase-only result, the 1024-wide reaction median rises from roughly 1.4--1.5 ms to 2.4--2.5 ms.
This is still below the cost of adding another complete reaction pass, but it is a fixed tax even
for the six-material scene.

The first SIMD version performed four property-table swizzles per vector and measured 2.54 ms for
six materials and 3.11 ms for twelve at 1024 width. Packing the left/right/top/bottom material bytes
with `i8x16.shuffle` reduces that to one `i8x16.swizzle`; after compact scalar/event lookup tables,
the final recorded run is 2.21 and 2.10 ms. This tuning sequence changed reaction dynamics as smoke
was added and the exact ratio is noisy, but it removes three unconditional swizzles; neighbor
classification, not the number of descriptors, remains the scaling boundary.

The movement kernel grows from 2,283 to 2,389 raw bytes and the fused reaction kernel from 1,430 to
2,352 bytes, for 4,741 raw bytes combined. In the production-shaped Vite build the reaction Wasm is
1,015 B gzip, the live-reaction showcase demo is 5,214 B gzip, and the complete reaction Worker route is 14,920 B
gzip. Neither enters the signals or Luna core entrypoints.

Acid corrosion, lava-water solidification, fire/lava spread, and water extinguishing fire into smoke
are implemented as symmetric reads from the previous generation and writes to the current cell only.
This preserves deterministic double-buffer ownership without a separate intent pass. Conflicts have
an explicit priority: solidification, extinguishing, corrosion, phase change, then ignition. A
time-based burning lifetime remains unimplemented; it needs an explicit contract for reusing the
temperature, flags, or variant byte.

The default reaction demo uses a labeled 5 x 2 lab. The upper row keeps all twelve ABI materials
available as isolated references; the lower row shows density exchange, extinguishing/vaporization,
solidification, corrosion, and ignition. Demo-only sources are restored every 90 ticks so irreversible
reactions remain observable without changing the reaction kernel or any Luna/signals entrypoint.

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

Status: conservative movement and resident rendering implemented as `runtime=block-webgpu`.
Optional bounded changed-block and semantic vaporized/condensed outputs are implemented as separate
compute-only entrypoints; contact, explosion, and application-specific events remain pending.

Keep cells, optional fields, and rendering resident on the GPU. One compute invocation owns one 2 x
2 block. Rendering samples the resulting storage buffer directly. Do not map the world buffer per
frame.

CPU-visible results use a bounded event buffer and summary counters. Read them asynchronously and no
more frequently than needed by gameplay. Overflow is observable and drops low-priority events rather
than stalling the simulation.

The prototype deliberately duplicates the compact movement WGSL in the event-enabled entrypoint.
This keeps atomic append and mapping code out of the normal renderer's lazy chunk; browser
conformance detects semantic drift between both shaders and the scalar oracle.

### Stage 6: coupled coarse fields

Status: a deliberately dense, per-cell `u8` temperature/reference reaction pass is implemented as
`runtime=worker-reaction-simd`, with a compute-only ping-pong WebGPU equivalent for conformance and
event/readback measurement. Integrating that pass into the resident movement renderer remains
pending, as do coarse temperature, pressure, and velocity fields.

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
  kind       i32
  index      i32
  before     u32
  after      u32
```

Candidate events include reaction, contact, explosion, chunk-awake, and chunk-sleep. Rendering dirty
pixels is not an event; it stays within the owning renderer. High-volume debug traces are disabled
in benchmark and production-shaped builds.

The CPU/Worker path publishes events through a `SharedArrayBuffer` SPSC ring. Its batch timestamp is
written only when reactions occur; the main thread reports the age of the newest published batch
when it drains records. This is a transport/scheduling metric, not the age of every record: queued
older batches can have higher latency.

The optional GPU path writes an atomic append buffer plus total and dropped counters, then copies one
fixed bounded region into staging. The changed-block implementation validates the transport and
overflow contract, but its measured event cardinality rejects it as a production gameplay
representation. The reaction implementation can either await every tick or accumulate a contiguous
multi-tick batch while rotating three staging buffers. The latter removes synchronization from the
submission hot path but trades away immediate event visibility. A gameplay feature that requires
the CPU to inspect most cells every tick is classified as a CPU/Worker workload rather than forced
onto WebGPU.

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
| optional event-tape JavaScript       | 1,050 B gzip |
| Wasm block kernel                    |  2,400 B raw |
| active-chunk addition                | 2,000 B gzip |
| WebGPU pair adapter and shaders      | 3,700 B gzip |
| WebGPU block adapter and shaders     | 5,600 B gzip |
| optional WebGPU block-event path     | 5,000 B gzip |
| optional WebGPU reaction-event path  | 5,000 B gzip |
| Worker client                        | 2,100 B gzip |
| scalar Worker                        | 5,450 B gzip |
| active-SIMD Worker + client + Wasm   | 9,000 B gzip |
| reaction Worker route and both Wasm  | 14,930 B gzip |
| reaction Wasm kernel                 |  1,600 B raw |

Generated lookup tables do not enter JavaScript when they can live in Wasm data or GPU buffers. Each
optional field has a separate measured entrypoint. A backend that needs a large runtime or material
VM remains application code rather than becoming UI-core.

The standalone reaction-event entry is currently 2,705 B gzip. Its Wasm-vs-WebGPU benchmark uses a
separate HTML/esbuild graph so importing the oracle cannot perturb the Pixel Lab production-shaped
Vite chunks. The live-reaction Pixel Lab demo is 5,214 B gzip under its 5,220 B experimental gate.

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
