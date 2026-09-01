# SIMD signal UI experiment

This experiment focuses on one data-oriented fast path for a UI runtime: deduplicating signal
fan-out before JavaScript callbacks run. It also measures an optional `SharedArrayBuffer`
dirty-effect set for multi-producer Workers. DOM mutation remains on the main thread.

The signal semantics are based on
[`mizchi/signals.mbt`](https://github.com/mizchi/signals.mbt/tree/aef6d02ee0190ca0d2a28ba66f6c89fc18edb93e/src).
That implementation walks linked subscribers and deduplicates its callback queue before flushing.
This experiment replaces only the bulk fan-out and queue-selection phase after changed signal IDs
are known. Dependencies remain explicit and immutable; optional computed signals add derived graph
propagation without automatic dependency tracking.

## Run

```sh
just test-ui-core-simd
just bench-ui-core-simd
just bench-ui-core-segments
just bench-ui-core-patch-tape
just bench-ui-core-atomics
just build-ui-comparison
just dev-ui-comparison
```

Open the Vite URL and press **Run all**, or append `?run=1`. The page reports its JSON result in the
Vite terminal as `UI_BENCHMARK_RESULT ...`.

## Entrypoints and size budgets

Features are split so the direct signal/DOM hot path does not absorb optional code:

| entrypoint                 | purpose                                         | gzip ceiling |
| -------------------------- | ----------------------------------------------- | -----------: |
| `signals.ts`               | fixed graph, SIMD/scalar dispatch, DOM bindings |      2,650 B |
| `computed.ts` + signals    | fixed derived signals                           |      2,700 B |
| `atomic_effect_batch.ts`   | optional Worker dirty set                       |        950 B |
| `atomic_input.ts`          | optional coalesced input slot and SPSC ring     |      1,200 B |
| atomic input + DOM adapter | pointer/click numeric extraction                |      1,500 B |
| `diagnostics.ts`           | memory estimation                               |        500 B |
| `regions.ts`               | optional Show/For structural regions            |        900 B |
| `segmented_scheduler.ts`   | dynamic segments over an immutable packed base  |      3,075 B |
| regions + scheduler        | combined Luna-style dynamic core                |      3,650 B |
| `patch_tape.ts` mixed      | optional numeric DOM command compaction         |      1,800 B |
| patch tape text lane       | tree-shaken homogeneous i32 text path           |      1,500 B |
| signals + text lane        | candidate Luna numeric-binding core             |      3,500 B |

`signals.wasm` remains separately capped at 220 raw bytes. The optional `patch_tape.wasm` is capped
at 420 raw bytes. `just check-ui-core-entrypoints` enforces every ceiling. Importing `signals.ts`
does not include the patch-tape JavaScript or Wasm.

## UI runtime

`signals.ts` is the primary entrypoint. A root owns its signals, explicit effect dependencies, DOM
nodes, and one immutable packed dispatch graph:

```ts
import { SimdUi } from "./signals.ts";

const ui = new SimdUi();
const count = ui.signal(0);
const root = ui.element("button", { onclick: () => count.value++ }, [
  "Count: ",
  ui.text([count], () => String(count.value)),
]);
await ui.mount(container, root);

ui.batch(() => {
  count.value++;
  count.value++;
});
```

`text()` and `effect()` use fixed dependency arrays. The fixed graph is deliberate: it makes queue
dispatch packable, but means this prototype does not offer Preact Signals' automatic and dynamic
dependency tracking.

Text bindings update `CharacterData.data` directly instead of the more general `textContent`
mutation path.

`destroy()` detaches the DOM, releases graph/effect references, and prevents later signal writes
from executing detached effects. If an effect throws, the current deduplicated queue is completed
before the first error is rethrown.

## Numeric patch tape

`patch_tape.ts` is an optional command-buffer experiment for compiler-generated bindings. It keeps
the mutable i32/f32 values and their previous 32-bit representations in Wasm linear memory. One SIMD
pass compares four bindings at a time, updates the previous snapshot, and compacts changed binding
IDs and raw values into two borrowed arrays. Four fully changed lanes use a vector store; sparse
vectors enumerate only their set bits.

```ts
import { applyTextI32Batch, NumericPatchTape } from "./patch_tape.ts";

const bindings = [
  { kind: "text-i32", target: 0 },
  { kind: "text-i32", target: 1 },
  { kind: "text-i32", target: 2 },
] as const;
const tape = await NumericPatchTape.create(bindings);

// A Luna compiler/runtime writes settled binding results into these stable views.
tape.i32Values[0] = 42;
tape.i32Values[1] = 7;
tape.i32Values[2] = -1;
applyTextI32Batch(tape.drain(), textNodes);
```

The static binding table owns DOM objects, property names, and opcodes in JavaScript. Only numeric
state and fixed-width commands cross the Wasm boundary. The first drain emits every binding; later
drains skip bit-identical values. Supported prototype commands are signed-integer text, boolean DOM
properties, and f32 CSS properties. Strings and general attributes stay outside this entrypoint.

The generic `applyPatchBatch()` remains as a correctness path for mixed text, boolean-property, and
style commands. It is not the intended hot path: the first browser prototype's per-command opcode
switch and target lookup lost badly to direct signal callbacks. A generated homogeneous text lane,
where `bindingId` directly indexes a text-node array, removes that switch and wins. Boolean and
style lanes should follow the same grouping rule rather than extending one central interpreter.

On the current Apple M5 Deno run, collection plus compiler-facing writes ranged from roughly parity
to 1.9x faster than the scalar fallback across 4,096 and 65,536 bindings at 1.6%, 25%, and 100%
change density. The benefit is workload-dependent and these numbers exclude real DOM mutation. Use
`just bench-ui-core-patch-tape` to reproduce the kernel-focused cases; the full browser path is
measured separately below.

The measured text-only payload is 1,397 gzip bytes of JavaScript plus 405 raw Wasm bytes. Bundling
it together with signals is 3,441 gzip bytes of JavaScript plus 603 raw Wasm bytes: a 797-byte gzip
JavaScript increase over the existing 2,644-byte signals entry, while importing signals alone
remains unchanged at 2,644 gzip bytes plus 198 raw Wasm bytes.

Representative local Chrome results on 2026-09-01 include binding evaluation, signal dispatch,
change compaction, string conversion, and real DOM writes:

| bindings | direct SIMD signals | homogeneous patch tape | Preact Signals |
| -------: | ------------------: | ---------------------: | -------------: |
|       64 |              5.0 µs |                11.0 µs |        26.0 µs |
|      512 |             66.7 µs |                26.7 µs |       186.7 µs |
|    4,096 |            280.0 µs |               220.0 µs |        1.96 ms |

The sub-10-microsecond row is close to timer resolution and the patch setup loses at that size. At
4,096 bindings the text lane is 1.27x faster than direct SIMD signals and 8.91x faster than Preact
in this fixed-dependency workload. Use `?run=patch` on the browser fixture to rerun only this
comparison.

### Patch-tape scenario matrix

`?run=patch-matrix&size=16384` separates update density, batching, dependency fan-out, and unchanged
outputs. All three runtimes mount the same 16,384 text nodes. The Preact fixture installs an
immediate scheduler only while timing so each sample includes its real DOM writes; every runtime
also reads and validates a changed DOM probe before the fixture is removed.

Representative isolated local Chrome results on 2026-09-01 (median of 11 samples after five
warmups):

| scenario            | affected / flushes / deps |   direct | patch tape |    Preact | patch vs direct | patch vs Preact |
| ------------------- | ------------------------: | -------: | ---------: | --------: | --------------: | --------------: |
| sparse batched      |               256 / 1 / 1 | 0.024 ms |   0.080 ms |  0.076 ms |           0.30x |           0.95x |
| 25% batched         |             4,096 / 1 / 1 | 0.400 ms |   0.360 ms |  1.560 ms |           1.11x |           4.33x |
| dense batched       |            16,384 / 1 / 1 | 1.567 ms |   1.467 ms | 15.167 ms |           1.07x |          10.34x |
| dense SIMD fan-out  |            16,384 / 1 / 8 | 1.067 ms |   1.067 ms | 29.600 ms |           1.00x |          27.75x |
| dense unbatched     |           16,384 / 64 / 1 | 5.800 ms |   8.600 ms | 11.800 ms |           0.67x |           1.37x |
| dense stable output |            16,384 / 1 / 8 | 1.000 ms |   0.767 ms | 20.367 ms |           1.30x |          26.57x |

The useful boundary is now clearer:

- emit a homogeneous patch lane for a large, batched group whose affected density is about 25% or
  higher;
- retain direct effects for sparse groups, because a tape drain scans the whole lane even when only
  1.6% of bindings can change;
- never drain a large lane after every individual signal write: 64 full scans made Patch Tape 1.48x
  slower than direct effects; and
- fuse numeric projection and equality into the lane when the selected outputs are often stable;
  this removed every DOM write and beat the equivalent computed/direct path by 1.30x.

For a Luna compiler, a conservative first rule is therefore: use direct bindings below 4,096
bindings or below 25% estimated update density, require a settled batch boundary, and enable Patch
Tape only for homogeneous numeric lanes. Update-locality partitioning could make sparse workloads
viable later by draining only touched sub-lanes.

### Luna integration contract

The Luna compiler should emit this path only when it can form a sufficiently large homogeneous
numeric lane. Each lane owns a stable direct-index target array and a numeric value view. Binding
evaluators write the view, then one final scheduler phase drains and applies it after computed
signals settle. Small or string-heavy groups retain direct scalar bindings. This keeps the feature
optional and prevents an opcode VM, string table, or Patch Tape Wasm from entering the minimal
signals bundle.

## Structural regions

`regions.ts` is an optional, DOM-independent lifecycle boundary for dynamic structure. It does not
enter the minimal signal bundle. `ShowRegion` swaps one disposable segment before a stable marker;
`KeyedRegion` reuses and moves keyed segments, and disposes removed segments before removing their
node ranges. A Luna adapter only needs `placeBefore` and `remove` host operations.

Every mounted segment owns a non-empty stable node range and a `dispose` callback. The callback is
also where a renderer unregisters the segment's fixed bindings from a packed scheduler. Empty
fragments use a placeholder node. This keeps structural reconciliation independent from signal queue
selection: a structural change adds or removes whole graph segments, while leaf updates keep using
immutable packed graphs inside surviving segments.

`segmented_scheduler.ts` supplies that registration boundary without delaying Luna's synchronous
render path. New bindings enter a small scalar overlay immediately. Once 64 effects accumulate by
default, the scheduler rebuilds one shared immutable `PackedSignalGraph` asynchronously and swaps it
in only if no registration changed during the build. Disposed base effects become inactive bytes;
when half the base is tombstoned by default, a rebuild compacts it. A keyed reorder changes neither
the packed graph nor the overlay. The chunk size and tombstone ratio are configurable from observed
UI lifetime patterns.

The scheduler deliberately does not run a binding when registering it: the renderer controls the
initial DOM write while constructing the segment. Later signal notifications are synchronous,
batched, and drain nested notifications before returning. Packing is only a representation change
and never delays effect visibility.

## Computed signals

`computed.ts` is optional and adds only about 44 gzip bytes over the direct signals entry:

```ts
import { computed } from "./computed.ts";

const subtotal = computed(ui, [price, quantity], () => price.value * quantity.value);
const label = ui.text([subtotal], () => String(subtotal.value));
```

Computed signals are acyclic by construction because their dependency list exists before the new
derived signal is returned. Diamond dependencies settle in ordered flush rounds, deduplicate the
join, and stop when `Object.is(previous, next)` reports no value change.

## Preact comparison

The browser fixture pins Preact 10.29.8 and `@preact/signals` 2.11.1. It runs three workloads with
the same logical DOM shape and dependency sets in both runtimes:

- flat fan-out: 64, 512, or 4,096 text bindings depend on eight of 16 input signals; and
- derived diamonds: each output has two computed branches, one computed join, and one text effect;
  and
- nested tree: a balanced four-way tree of depth 3-5 contains 64, 256, or 1,024 leaf cards, with
  four bindings per card depending on four of 32 input signals.

Each sample changes one quarter to one half of the inputs in a batch. The nested benchmark verifies
that both runtimes mounted the same number of branch, leaf, and total DOM elements before timing.
Preact receives computed signals directly as text children, enabling its direct-DOM optimization.
During each Preact sample the fixture replaces its animation-frame scheduler with an immediate
callback, then reads a DOM probe, so update timings cannot stop at the queued-signal phase. The
trees are mounted before timing, so this measures reactive leaf updates through a realistic DOM
hierarchy; it does not benchmark structural reconciliation.

This is a specialized-kernel comparison, not a feature-parity claim. Preact supports automatic
dependencies, components, keyed reconciliation, lifecycle, hooks, SSR, and a mature ecosystem.

Representative isolated local Chrome run on 2026-09-01 (median and p95 of 11 samples after five
warmups; update timing excludes mount and fixture construction):

| leaves | bindings | SIMD median / p95 | Preact median / p95 | speedup | mount SIMD / Preact |
| -----: | -------: | ----------------: | ------------------: | ------: | ------------------: |
|     64 |      256 |  0.038 / 0.053 ms |    0.089 / 0.102 ms |   2.34x |        0.8 / 2.6 ms |
|    256 |    1,024 |  0.067 / 0.070 ms |    0.193 / 0.200 ms |   2.90x |        0.6 / 2.8 ms |
|  1,024 |    4,096 |  0.300 / 0.350 ms |    1.570 / 3.670 ms |   5.23x |       1.8 / 14.4 ms |

Derived diamond results show the expected small-graph crossover:

| outputs | SIMD median / p95 | Preact median / p95 |       result |
| ------: | ----------------: | ------------------: | -----------: |
|      16 |  0.006 / 0.012 ms |    0.004 / 0.007 ms | Preact 1.50x |
|      64 |  0.029 / 0.047 ms |    0.038 / 0.044 ms |   SIMD 1.31x |
|     256 |  0.090 / 0.143 ms |    0.157 / 0.187 ms |   SIMD 1.74x |

The smallest values are close to browser timer quantization; rerun the fixture for decisions about
small trees. The larger cases are the more useful signal for this specialized fixed-graph design.
The current fixture also reports p95 update latency and mount time separately from update medians.

### Large layered graphs

The fixture also holds the computed-node count constant while changing graph width and depth. Every
computed node has four fixed dependencies, the final layer has one text binding per node, and eight
of 32 roots change per batch. Each row below ran in a fresh page so garbage collection from the
previous shape could not affect it:

| computed | width × depth | SIMD UI median / p95 | Preact median / p95 | result | dense before → after | mount SIMD / Preact |
| -------: | ------------: | -------------------: | ------------------: | -----: | -------------------: | ------------------: |
|    4,096 |     1,024 × 4 |     0.300 / 0.500 ms |    0.600 / 0.780 ms |  2.00x |        2.5 MiB → 0 B |        3.9 / 5.1 ms |
|    4,096 |      256 × 16 |     0.400 / 0.700 ms |    0.400 / 0.620 ms |    tie |        2.1 MiB → 0 B |        3.5 / 3.0 ms |
|    4,096 |       64 × 64 |     0.260 / 0.500 ms |    0.320 / 0.400 ms |  1.23x |        2.1 MiB → 0 B |        2.0 / 1.8 ms |
|   16,384 |     2,048 × 8 |     1.080 / 1.200 ms |    2.460 / 2.940 ms |  2.28x |       36.1 MiB → 0 B |        5.7 / 8.0 ms |
|   16,384 |      256 × 64 |     1.040 / 1.160 ms |    1.680 / 1.800 ms |  1.62x |       32.6 MiB → 0 B |        5.1 / 5.9 ms |
|   16,384 |      64 × 256 |     1.000 / 1.240 ms |    1.620 / 1.720 ms |  1.62x |       32.3 MiB → 0 B |        3.9 / 3.3 ms |

The automatic dispatcher chose the scalar subscriber walk for all layered cases: internal computed
signals have low fan-out, so scanning a full effect bitmap is more expensive than visiting their
short subscriber lists. At 4,096 nodes the deep graph's p95 still loses to Preact, even though its
median wins. This is a flush-round latency issue rather than a bitmap issue.

Selective dense rows remove the matrix from all six layered shapes. Including the minimum Wasm page,
subscriber IDs, generation marks, result IDs, and signal-to-dense-row map, the typed backing
estimate for a 16,384-node shape is roughly 0.5 MiB instead of 32-36 MiB, excluding JavaScript
object overhead. High-fan-out roots in the flat and complex-tree workloads still retain dense SIMD
rows.

## Packed signal graph

`PackedSignalGraph` stores two representations:

- sparse `Uint32Array` subscriber lists for low fan-out; and
- selective signal-by-effect dense bitmap rows for one-call Wasm SIMD union.

`collect(changedSignals)` returns sorted effect IDs with every effect present at most once. SIMD
collections, including the trusted `collectPacked()` path, return a graph-owned result view that is
valid until the next collection, avoiding per-flush result arrays; callers must copy it when
retaining the result. The UI runtime consumes it immediately and then invokes JavaScript callbacks.
SIMD does not execute callbacks or traverse object pointers.

Each dense row costs `align4(ceil(effectCount / 32)) * 4` bytes. A signal receives one only when its
subscriber count reaches that row cost in u32 words. The automatic planner uses SIMD when at least
two changed signals all have dense rows; mixed or sparse batches use the subscriber walk. Explicit
`simd` requests also fall back to scalar when the selected rows were intentionally omitted.

If SIMD Wasm compilation or instantiation fails, graph creation now keeps the sparse representation
and transparently resolves every dispatch to scalar. Passing `{ wasm: false }` makes this fallback
deterministic for tests or restricted environments.

`diagnostics.ts` estimates selective dense rows, rounded Wasm linear memory, subscriber arrays,
scalar generation marks, the row map, and reusable effect-ID storage without adding code to the
runtime entrypoint.

`SimdUi` keeps changed IDs in a preallocated `Uint32Array` with byte flags instead of allocating a
`Set` during every flush. With reusable SIMD result storage, its trusted packed-input path measured
1.33-1.93x faster than normalizing a generic iterable and 3.47-4.08x faster than the previous
allocate-and-copy result path in the isolated dense cases. The scalar path uses generation marks and
only visits subscribers, avoiding a full effect-bitmap scan for sparse graphs. Consecutive SIMD
collections with the same result length also reuse the same typed-array view; this reduced the
1,024-effect packed case from 0.265 to 0.238 microseconds, while the 8,192-effect case was unchanged
within benchmark noise.

## Results

Measured on Apple M5, Deno 2.6.4, 2026-09-01. Values include sorted effect enumeration.

| effects | fan-out/signal | changed signals | sparse scalar | selected dispatch |      result |
| ------: | -------------: | --------------: | ------------: | ----------------: | ----------: |
|     128 |              4 |               2 |        1.4 us |          0.255 us |  SIMD 5.55x |
|   1,024 |             64 |               8 |       21.1 us |          0.790 us | SIMD 26.75x |
|   8,192 |              4 |               2 |       0.55 us |       scalar only |  sparse row |
|   8,192 |          1,024 |              16 |       94.4 us |            2.2 us | SIMD 43.51x |
|  65,536 |              4 |               2 |       0.44 us |       scalar only |  sparse row |
|  65,536 |          8,192 |              16 |        2.7 ms |           40.2 us | SIMD 66.25x |

The SIMD gain peaks for dense fan-out. Enumerating the result bitmap becomes a shared cost for very
large effect sets.

### Atomics and persistent Workers

Single-thread `Atomics.or` plus exchange-drain remains slower than a local bitmap. In the latest
Apple M5 Deno run, four persistent Workers repaid their messaging overhead even at the smaller
batches, although the absolute sub-millisecond difference is not meaningful UI work by itself:

| marks/batch | sequential Atomics | 4 persistent Workers | worker/sequential |
| ----------: | -----------------: | -------------------: | ----------------: |
|       1,024 |           0.089 ms |             0.068 ms |      1.31x faster |
|      16,384 |           0.286 ms |             0.131 ms |      2.18x faster |
|     262,144 |           2.129 ms |             1.825 ms |      1.17x faster |
|   1,048,576 |           8.411 ms |             6.427 ms |      1.31x faster |

Atomics therefore remains an opt-in Worker interoperability boundary and is not part of the
main-thread scheduler hot path.

### Atomic pointer and click bridge

`atomic_input.ts` is a separate Worker-input entrypoint. It deliberately uses two delivery modes:

- one 32-byte seqlock slot for coalescible `pointermove`; every write replaces the previous
  position, so a slow Worker consumes the newest pointer state instead of building a backlog; and
- a power-of-two SPSC ring of 32-byte records for `pointerdown`, `pointerup`, `pointercancel`, and
  `click`, preserving order and counting overflow.

`atomic_input_dom.ts` synchronously extracts only a compiler-assigned target ID, 1/64 CSS-pixel
coordinates, pointer ID, buttons, modifiers, microsecond timestamp, pressure, and click detail. It
does not retain or transfer the Event or DOM target and allocates no object on the event hot path:

```ts
const input = AtomicInputBuffer.create(64);

surface.addEventListener("pointermove", (event) => {
  writeLatestPointerEvent(input, ATOMIC_INPUT_KIND.pointerMove, targetId, event);
});
surface.addEventListener("click", (event) => {
  writeDiscretePointerEvent(input, ATOMIC_INPUT_KIND.click, targetId, event);
});

// Worker
const peer = AtomicInputBuffer.attach(sharedBuffer);
const latest = new Int32Array(8);
const discrete = new Int32Array(64 * 8);
peer.readLatestInto(latest);
const count = peer.drainInto(discrete);
```

Both delivery modes increment one shared wake sequence. A dedicated Worker can block with
`waitForInput(previousSequence)` and drain both sources after waking, avoiding a per-event
`postMessage`.

The u32 microsecond timestamp wraps after roughly 71 minutes; consumers compare it modulo 2^32.
`preventDefault()`, pointer capture, focus, and selection stay in the main-thread listener. A Luna
compiler can assign stable numeric target IDs and emit the adapter call directly.

On Apple M5/Deno, 4,096 writes including the shared wake notification took 315.7 microseconds for
the latest slot (about 77 ns/write). Pushing and draining 4,096 discrete records took 548.7
microseconds (about 134 ns/record). The cross-origin-isolated browser fixture `?run=input&autorun=1`
verified that 100 PointerEvents coalesced to the last position while pointerdown/up/click arrived at
the Worker in order with no drops. The core is 1,178 gzip bytes; adding the DOM extraction adapter
is 1,452 gzip bytes. Neither enters `signals.ts` or the Patch Tape bundle.

The interactive `?run=life` route turns this bridge into a 256 × 160 Conway's Game of Life demo. The
Worker owns all 40,960 cells, simulation steps, and drag-line reconstruction. `pointermove` events
overwrite the latest slot, while `pointerdown/up/cancel` remain ordered in the discrete ring. The
route accepts `?run=life&runtime=simd|scalar&size=256|512|1024&renderer=auto|main|offscreen`; the
height remains 5/8 of the width. `auto` is the default: it keeps surfaces below 262,144 cells on the
main thread, selects OffscreenCanvas at or above that provisional crossover, and falls back to main
when OffscreenCanvas is unavailable. The main renderer publishes through a double-buffered
`SharedArrayBuffer`, while the offscreen renderer transfers the Canvas to the Worker and publishes
only an 80-byte seqlocked statistics/control header. The latter avoids both the cell snapshot and
the per-frame main-thread RGBA conversion. The UI reports rolling compute/render medians,
input-to-frame latency, observed frame rate, and exact compute/shared allocations. Run
`just dev-ui-comparison`, then open the printed local URL with
`?run=life&runtime=simd&renderer=auto`.

The compute-only Worker keeps the blocking `Atomics.wait` loop. The OffscreenCanvas Worker instead
awaits `Atomics.waitAsync`, yielding its event loop after every `putImageData` so the browser can
present the new bitmap. Browsers without `waitAsync` use bounded 8 ms timer polling. A blocking
infinite loop here still computes and publishes statistics, but only its initial Canvas frame can
reach the compositor.

The optional Life kernel is 664 raw / 368 gzip bytes and uses `i8x16` addition and comparison for
the contiguous interior of each row. Sixteen wraparound/tail cells per row stay scalar, avoiding a
halo copy or a strided board. Its two generations live directly in Worker-owned Wasm memory; only a
completed generation is copied to the shared display buffer. `just bench-ui-life-kernel` produced
these Apple M5/Deno medians:

|       grid |   cells |  Scalar JS | Wasm SIMD | speedup |
| ---------: | ------: | ---------: | --------: | ------: |
|  256 × 160 |  40,960 |   111.7 µs |   10.0 µs |  11.13× |
|  512 × 320 | 163,840 |   526.0 µs |   28.9 µs |  18.18× |
| 1024 × 640 | 655,360 | 2,483.3 µs |   97.5 µs |  25.46× |

The browser autorun waits for 20 generations and reports rolling medians from 11 sequential pointer
taps. Local Chrome produced 25 µs SIMD versus 380 µs Scalar JS at 256 × 160, and 155 µs versus 3,920
µs at 1024 × 640. Input-to-frame stayed 4.9–7.3 ms across both runtimes and sizes with no dropped
records. The 1024 × 640 Canvas painted about 26–28 fps at the default 30 Hz, so display conversion
becomes the next bottleneck even though the SIMD compute remains below 0.2 ms.

An OffscreenCanvas A/B run shows that it is a large-surface optimization, not an unconditional win:

|       grid | renderer  | input-to-frame | render median | observed fps | shared memory |
| ---------: | :-------- | -------------: | ------------: | -----------: | ------------: |
|  256 × 160 | main      |        4.39 ms |        170 µs |         29.7 |      88.2 KiB |
|  256 × 160 | offscreen |        8.38 ms |         75 µs |         30.0 |       8.2 KiB |
|  512 × 320 | main      |        7.54 ms |        465 µs |         30.0 |       328 KiB |
|  512 × 320 | offscreen |        8.15 ms |        455 µs |         30.0 |       8.2 KiB |
| 1024 × 640 | main      |        9.90 ms |      1,145 µs |         27.8 |      1.26 MiB |
| 1024 × 640 | offscreen |        8.28 ms |      1,085 µs |         28.0 |       8.2 KiB |

These are local Chrome autorun medians, so the exact input number includes the rAF/Worker phase. At
40,960 cells the handoff is not repaid; at 655,360 cells it removes main-thread pixel work, reduces
shared allocation by about 99.4%, and improves the sampled input latency by about 16%.

The optional `load=0..8` benchmark parameter burns that many milliseconds on the main thread per rAF
to model unrelated application work; it also reports the rAF gap p95. At 1024 × 640 with `load=4`,
main rendering reported 9.165 ms input-to-frame, 2.68 ms render, and a 14.1 ms rAF-gap p95.
Offscreen rendering reported 6.535 ms, 1.03 ms, and 9.28 ms respectively. Under this mixed load,
moving pixels off-thread improved sampled input latency by about 29%. This synthetic load is a
stress fixture, not a substitute for INP measurements in a real Luna application.

### Pixel Lab: conservative material cells

The next pixel-physics experiment, its backend contract, TDD stages, benchmark matrix, and bundle
gates are recorded in [`PIXEL_PHYSICS_PROTOTYPE.md`](./PIXEL_PHYSICS_PROTOTYPE.md). It keeps the
current pair-pass implementation as the control group and starts with a Margolus-style 2 x 2 block
solver.

The optional `?run=pixel` route broadens the Canvas experiment from a uniform Life rule to a
material cellular automaton. Its v0 cell ABI is one `u32`: material, temperature, flags, and variant
each occupy one byte. Empty, wall, sand, and water are implemented; temperature is reserved but is
not updated yet. A tick consists of vertical, diagonal, and horizontal disjoint-pair passes. Passes
swap complete cells, so material counts and metadata are conserved without per-cell atomics. The
CPU and WebGPU paths share the same parity and pair-count contract.

Open
`?run=pixel&runtime=cpu|active|worker|webgpu&size=256|512|1024&occupancy=5|25|75&region=full|quarter|spot&load=0..8`.
The CPU path performs scalar in-place pair swaps and converts the resulting cells to `ImageData`.
The active path applies the identical rules only to hot 32 × 32 chunks and their one-chunk halo;
chunks cool after two idle parities and pointer brushes wake their neighborhood. The WebGPU path
keeps the cells in a storage buffer, dispatches three compute passes, and samples that buffer
directly from the Canvas fragment shader; it performs no frame readback. Pointer input is reduced
to a cell coordinate, material, and radius before a small brush dispatch. The autorun case injects
11 pointer samples and reports input-to-present latency as well as synchronized GPU completion time.

The Worker path runs the active-chunk implementation and `ImageData` presentation behind a
transferred `OffscreenCanvas`. Main-thread pointer listeners synchronously write only fixed-point
coordinates, pointer flags, and timestamps into the existing `AtomicInputBuffer`; coalesced moves
are reconstructed into continuous brush lines in the Worker. An independent 80-byte seqlocked
control block publishes tick, compute/render timings, active chunks, run state, and the timestamp of
the last presented input. No cell snapshot crosses the thread boundary.

`just bench-ui-pixel-browser` runs the full 3 × 3 × 4 × 2 matrix in isolated headless Chrome
profiles. The axes can be narrowed with `JSIMD_PIXEL_WIDTHS`, `JSIMD_PIXEL_OCCUPANCIES`,
`JSIMD_PIXEL_RUNTIMES`, and `JSIMD_PIXEL_REGIONS`. Representative Apple M5 results at 25%
occupancy were:

| world | runtime | tick + present median | input-to-present | resident buffers |
| ----: | :------ | --------------------: | ---------------: | ---------------: |
| 512 × 320 | CPU | 0.710 ms | 14.20 ms | 1.25 MiB |
| 512 × 320 | WebGPU | 0.745 ms | 17.12 ms | 640 KiB |
| 1024 × 640 | CPU | 2.730 ms | 12.11 ms | 5.00 MiB |
| 1024 × 640 | WebGPU | 0.865 ms | 17.12 ms | 2.50 MiB |

This exposes a useful boundary: at 163,840 cells, GPU queue/synchronization cost is not repaid; at
655,360 cells, WebGPU is about 3.2× faster for the dense full-grid tick and uses half the explicitly
owned memory. WebGPU brush presentation adds roughly one display interval in this harness, so CPU
input latency remains lower. At 1024 × 640, changing occupancy from 5% to 75% moved WebGPU from
0.825 to 0.945 ms and CPU from 2.505 to 2.840 ms. Both still scan the full world, which deliberately
makes the missing sparse-world optimization visible.

At 1024 × 640, the locality axis separates full-world density from a localized workload:

| region | runtime | compute median | tick + present | active chunks |
| :----- | :------ | -------------: | -------------: | ------------: |
| full | CPU | 2.30 ms | 2.84 ms | - |
| full | Active CPU | 3.74 ms | 4.34 ms | 571 / 640 |
| spot | CPU | 1.32 ms | 1.93 ms | - |
| spot | Active CPU | 0.665 ms | 1.21 ms | 178 / 640 |
| spot | WebGPU | GPU-synchronized | 1.07 ms | full dispatch |

Chunk scheduling is therefore harmful when almost the whole world moves, but halves CPU compute
time when activity covers roughly 28% of chunks. The fixed 0.55 ms `ImageData` conversion remains
after sparse compute and is the reason WebGPU still narrowly wins the complete spot frame.

The Worker experiment changes ownership rather than making the kernel itself faster. At 1024 × 640
with 8 ms of synthetic main-thread work, the measured main-frame work was 12.38 ms for full active
CPU versus 8.09 ms for Worker, and 9.23 ms versus 8.09 ms for the spot case. Worker compute was
slower in the isolated Chrome runs and sampled input-to-present was about 2–3 ms worse, so this is a
throughput/jank trade rather than an unconditional latency win. It pays when the UI has other
main-thread work to overlap; WebGPU remains the stronger dense-grid backend.

The lazy chunks are 4.81 KiB gzip for the Pixel UI/CPU path, 1.60 KiB for active chunks, and 3.33
KiB for WebGPU. Worker selection additionally loads a 1.91 KiB main-thread adapter and a 5.02 KiB
self-contained Worker. Their byte ceilings are 5,000, 1,700, 3,700, 2,000, and 5,300 respectively.
None enters the signals, computed, Atomics, or Patch Tape entrypoints; all existing core ceilings
also remain enforced by `just test-ui-core-simd`.

This is a benchmarkable material kernel, not yet a Sandustry/Noita-like engine. Disjoint pairing
avoids races but produces lattice artifacts and cannot express long-range machines, rigid bodies,
connected-component updates, or arbitrary material scripts. The next discriminating steps are an
optional SIMD heat/reaction scan, multi-pass movement intents for less grid-biased GPU motion, and
a DOM-backed stress fixture that separates simulation gains from Canvas-only gains.

### Browser memory and event-loop profile

The isolated browser route
`?run=profile&runtime=direct|patch|preact|atomics&size=4096|16384&autorun=1` enables COOP/COEP,
measures fresh-page memory with `performance.measureUserAgentSpecificMemory()`, warms each fixture,
and records 11 dense updates. A user-blocking `scheduler.postTask()` is queued at each update start
to measure when the event loop becomes responsive again. Event-to-DOM includes Worker completion and
the main-thread DOM commit. The Atomics fixture uses four persistent Workers, a shared i32 value
array, and `AtomicEffectBatch`; Workers own contiguous binding ranges to avoid dirty-word false
sharing.

Representative local Chrome results on 2026-09-01:

| bindings | runtime | mounted memory delta | known typed/shared backing | main-thread median | event-to-DOM median | Worker median |
| -------: | ------- | -------------------: | -------------------------: | -----------------: | ------------------: | ------------: |
|    4,096 | Direct  |             2.00 MiB |                    224 KiB |            1.33 ms |             1.35 ms |             - |
|    4,096 | Patch   |             2.01 MiB |                    289 KiB |            0.60 ms |             0.62 ms |             - |
|    4,096 | Preact  |            10.09 MiB |                          - |            4.50 ms |             4.52 ms |             - |
|    4,096 | Atomics |             2.34 MiB |                   16.6 KiB |            0.66 ms |             1.63 ms |       0.94 ms |
|   16,384 | Direct  |             7.80 MiB |                    832 KiB |            5.04 ms |             5.07 ms |             - |
|   16,384 | Patch   |             8.33 MiB |                   1.06 MiB |            5.26 ms |             5.28 ms |             - |
|   16,384 | Preact  |            39.51 MiB |                          - |           75.37 ms |            75.39 ms |             - |
|   16,384 | Atomics |             4.79 MiB |                   66.1 KiB |            2.24 ms |            17.84 ms |      15.73 ms |

Memory deltas include the common DOM nodes and runtime objects; the known-backing column contains
only deterministic Wasm/typed/shared buffers. The Atomics fixture is intentionally a Worker-source
bridge and does not retain a main-thread reactive dependency graph, so its lower memory is not a
feature-parity claim. Repeated fresh-page Patch measurements at 16,384 bindings varied by about 0.8
MiB, while its Direct-sized memory and Preact's roughly five-times larger delta were stable
conclusions.

Atomics changes the latency trade-off rather than making a click-triggered update absolutely faster.
At 16,384 bindings it reduced additional event-loop blocking from about 5.3 ms to 0.05 ms and
main-thread work from 5.26 ms to 2.24 ms, but Worker scheduling raised event-to-DOM latency from
5.28 ms to 17.84 ms (22.68 ms p95). It therefore fits data already produced off-thread: Workers
publish continuously and the main thread drains once per animation frame. A user interaction that
must immediately change the DOM should stay on the direct/Patch path; using Worker request/response
as part of that interaction's critical path loses.

## Direction

- Make the hybrid sparse/Wasm SIMD signal collector the only UI-core fast path.
- Keep `AtomicEffectBatch` as an opt-in Worker bridge.
- Optimize trace-derived fan-out distributions and direct DOM bindings before adding structural
  reconciliation.
