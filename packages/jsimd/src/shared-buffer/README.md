# SharedBuffer

A versioned shared-memory ABI for attaching multiple Web Workers to the same `WebAssembly.Memory`.
It is the foundation for later queues, allocators, atomic bitmaps, striped reducers, and immutable
snapshots; it is not a general-purpose allocator by itself.

```ts
import { SharedBuffer } from "@mizchi/jsimd/shared-buffer";

// Main thread or owner Worker
using shared = await SharedBuffer.create({ initialPages: 1, maximumPages: 16, maxWorkers: 8 });
worker.postMessage(shared.memory);

// Receiving Worker
self.onmessage = async (event: MessageEvent<WebAssembly.Memory>) => {
  using shared = await SharedBuffer.attach(event.data);
  Atomics.add(shared.uint32Array(0, 1), 0, 1);
};
```

Disposing a `SharedBuffer` releases only the current realm's worker lease. It does not destroy the
backing shared memory, which can remain attached elsewhere. Worker IDs are reused only after the
corresponding lease is released or explicitly reclaimed. Each attachment receives a
generation-tagged `workerLease`; after `Worker.terminate()` has completed, a coordinator can call
`shared.reclaimTerminatedWorker(workerLease)`. Exact-token CAS ensures that a delayed termination
notification cannot detach a replacement generation. This is explicit recovery, not heartbeat-based
failure detection: the caller must first establish that the old Worker can no longer access memory.

## ABI and ownership

The first cache line contains the magic, ABI version, header size, maximum page count, worker
capacity, and active-worker count. It is followed by one 64-byte generation/lease slot per Worker,
keeping independent ownership words off the same cache line. The packed token supports at most 255
Worker slots. Payload starts at the next 64-byte boundary and all Wasm-facing offsets remain at
least 16-byte aligned.

Every realm asynchronously compiles the prebuilt Wasm asset once, then imports the same shared
`WebAssembly.Memory` into its own kernel instance. `instantiateSharedModule` exposes the synchronous
module-plus-memory step for later data-structure kernels. Compilation uses the asset URL in Vite and
Deno and Node 24's built-in file access for local ESM. The memory has an explicit maximum because
shared Wasm memory requires one.

`uint8Array` and `uint32Array` return shared typed-array views relative to the payload. Existing
views should not be retained across `grow`; obtain a fresh view from the `SharedBuffer` after
growth.

## Synchronization views

`SharedMutex`, `SharedBarrier`, and `SharedWaitGroup` each occupy one 64-byte cache line in the
payload. Initialize them before publishing the memory, then attach a local view in each Worker. They
do not own memory and therefore are not disposable; the surrounding `SharedBuffer` lease uses
`using`.

```ts
import {
  SHARED_SYNC_BYTE_LENGTH,
  SharedBarrier,
  SharedBuffer,
  SharedMutex,
  SharedWaitGroup,
} from "@mizchi/jsimd/shared-buffer";

using shared = await SharedBuffer.create({ maxWorkers: 5 });
SharedMutex.initialize(shared, 0);
SharedBarrier.initialize(shared, SHARED_SYNC_BYTE_LENGTH, 4);
const tasks = SharedWaitGroup.initialize(shared, SHARED_SYNC_BYTE_LENGTH * 2, 4);
worker.postMessage(shared.memory);

// Browser main threads must use the asynchronous variants.
await tasks.waitAsync();
```

```ts
// In each receiving Worker:
self.onmessage = async (event: MessageEvent<WebAssembly.Memory>) => {
  using shared = await SharedBuffer.attach(event.data);
  const mutex = SharedMutex.attach(shared, 0);
  const barrier = SharedBarrier.attach(shared, SHARED_SYNC_BYTE_LENGTH);
  const tasks = SharedWaitGroup.attach(shared, SHARED_SYNC_BYTE_LENGTH * 2);

  barrier.arriveAndWait();
  mutex.lock();
  try {
    shared.uint32Array(SHARED_SYNC_BYTE_LENGTH * 3, 1)[0]++;
  } finally {
    mutex.unlock();
    tasks.done();
  }
};
```

The mutex is non-reentrant and validates its Worker lease before unlocking. A mutex owner token left
by a terminated Worker is replaced when a later generation next claims it. The barrier is reusable
but has a fixed party count; a missing or terminated party leaves the current generation waiting.
The wait group count cannot become negative, and adding new tasks concurrently with a zero-count
wait is outside its contract. Barrier arrivals and wait-group work items are semantic obligations,
not ownership leases, so reclaiming a Worker cannot infer whether to complete or cancel them.

Blocking methods use `Atomics.wait`. Async methods use `Atomics.waitAsync`; Deno 2.6 / V8 currently
needs a 1 ms state-check fallback for growable Wasm shared memory because notification does not
resolve that promise. This can add up to 1 ms of async wake latency in affected runtimes. Mutexes
are for coarse critical sections—not per-element loops where direct atomic RMW or worker-local
striping is preferable.

## Fixed-size block pool

`SharedBlockPool` allocates 256-byte, 1 KiB, and 4 KiB blocks from a fixed arena. The fast path uses
one cache line per Worker and does not perform atomic RMW. Cache misses use an atomic bump pointer
or one mutex-protected free list per size class. Blocks are owning leases and should use `using`.

```ts
import { SharedBlockPool, SharedBuffer } from "@mizchi/jsimd/shared-buffer";

using shared = await SharedBuffer.create({ initialPages: 4, maximumPages: 4 });
const pool = SharedBlockPool.initialize(shared, 0);

{
  using block = pool.allocate(1_024);
  block.uint8Array().fill(0);
}

pool.outstandingBlocks; // 0
```

`initialize` reserves its header, three lock lines, and one cache line per configured Worker. By
default the arena begins at the next 4 KiB boundary and extends to the current end of the shared
payload. Custom `arenaByteOffset` / `arenaByteLength` values allow multiple structures to share one
buffer; layout overlap remains the caller's responsibility.

Allocation and release are Worker-oriented because a free-list miss may call blocking
`SharedMutex.lock`. There is no zero-fill guarantee for reused blocks, and retaining a typed-array
view after the block lease is disposed is unsafe. After reclaiming a terminated `SharedBuffer`
lease, call `pool.reclaimTerminatedWorker(workerLease)` to flush its cached free blocks back to the
global lists. A replacement attachment also adopts and flushes a stale cache automatically. The pool
cannot force-release live block handles because ownership may already have been transferred to
another Worker. The pool is useful when fixed-size shared payloads must be recycled; native
JavaScript allocation remains preferable for data that does not need to live in Wasm shared memory.

The deterministic reuse test allocates and releases 64 blocks over 20 rounds. `reservedBytes`
reaches its plateau after the first round, with zero outstanding blocks after every round. A
four-Worker test also holds 64 blocks concurrently, verifies that all offsets are unique, and then
returns them through Worker-local caches and the shared free list. Another test forcibly terminates
a Worker after it fills its local cache, reclaims the exact lease generation and cache, reattaches
the same worker ID, and verifies that `reservedBytes` remains at the pre-termination plateau.

On the recorded Node 24.12 / Apple M5 microbenchmark, a cached 256-byte pool lease took 0.000184 ms
and `new Uint8Array(256)` took 0.000167 ms: native allocation was 1.10x faster. The pool is not an
optimization for local JavaScript allocation; its value is stable offsets, cross-Worker reuse, and
bounded growth inside shared Wasm memory.

The memory-profile scenario ran 1,000 allocate/release cycles with zero live allocations after each
sample. Reserved storage stabilized at 8 KiB after the first sample, and host heap, external memory,
and `arrayBuffers` remained within the profiler's plateau threshold.

## SPSC ring buffers

`SpscRingBufferU32` transports `u32` offsets or compact handles, while `SpscRingBufferU64`
transports complete generation-tagged handles as `bigint`. The monotonic head and tail counters
occupy separate 64-byte cache lines. Each role is an exclusive lease; declare it with `using` so
another Worker can claim the role after normal completion.

```ts
import { SharedBuffer, SpscRingBufferU32 } from "@mizchi/jsimd/shared-buffer";

// Before publishing the memory:
using shared = await SharedBuffer.create({ maxWorkers: 2 });
const ring = SpscRingBufferU32.initialize(shared, 0, 1_024);
using consumer = ring.consumer();
worker.postMessage({ memory: shared.memory });

// Browser main thread: asynchronous backpressure.
const handle = await consumer.popAsync();
```

```ts
// In the producer Worker:
using shared = await SharedBuffer.attach(event.data.memory);
const ring = SpscRingBufferU32.attach(shared, 0);
using producer = ring.producer();
producer.push(handle); // Worker-blocking backpressure
```

Both variants have the same lifecycle and method names; u64 bulk methods accept `BigUint64Array`.
Capacity must be a power of two. `tryPush` / `tryPop` never wait. `push` / `pop` use `Atomics.wait`
and are Worker-only; `pushAsync` / `popAsync` use `Atomics.waitAsync` for main-thread compatibility.
`pushMany` / `popMany` use native typed-array copies. When the source or destination already resides
in the same `SharedBuffer`, `pushManyFromShared` / `popManyToShared` use the Wasm `v128` copy kernel
and avoid crossing the JS boundary with the payload. That shared-to-shared SIMD copy is currently
u32-only; the u64 bulk API performs typed-array-to-ring conversion in JavaScript.

This queue supplies synchronization and bounded backpressure that JavaScript has no built-in
shared-memory collection for; it does not claim that scalar enqueue/dequeue beats hand-written
JavaScript `Atomics`. The SIMD path only applies to non-overlapping shared-to-shared bulk copies.
Producer and consumer roles store generation-tagged owner tokens, so a later attachment can reclaim
a role left by a terminated Worker. Queue items already published before termination remain subject
to the application's delivery/retry policy. The memory profiler repeatedly acquires both roles and
transfers 4,096 handles; failure to release either role prevents the next cycle, while the backing
shared memory must remain at one fixed page.

## MPMC ring buffers

`MpmcRingBufferU32` and `MpmcRingBufferU64` are the bounded multiple-producer/multiple-consumer
counterparts. Use u32 for compact offsets and u64 for complete `SharedSlotMap` handles. Enqueue and
dequeue positions occupy separate cache lines. Each slot stores one payload and an atomic sequence
number: a producer publishes by advancing the sequence, and a consumer recycles the slot by
advancing it by one capacity.

```ts
import { MpmcRingBufferU32, SharedBuffer } from "@mizchi/jsimd/shared-buffer";

// Initialize once before publishing the memory.
using shared = await SharedBuffer.create({ maxWorkers: 9 });
const queue = MpmcRingBufferU32.initialize(shared, 0, 1_024);
workers.forEach((worker) => worker.postMessage(shared.memory));

// Any producer or consumer Worker may attach the same queue.
queue.tryPush(taskHandle);
const nextTask = queue.tryPop();
```

`push` / `pop` block a Worker and `pushAsync` / `popAsync` support a browser main thread. The u64
variant accepts `bigint` and `BigUint64Array`; its single sequence store publishes both 32-bit
payload words as one queue item, so a generation-tagged handle is never split across independently
published entries. Capacity must be a power of two. `pushMany` / `popMany` amortize the TypeScript
call site but still perform one CAS and one atomic sequence publication per handle; unlike SPSC
shared-to-shared transfer, this is not a SIMD copy path. Contention on enqueue/dequeue positions can
make it slower than sharded or per-Worker queues, so prefer SPSC channels or worker-local batches
when the communication topology allows them. JavaScript has no built-in shared-memory MPMC
collection, and no throughput advantage over a hand-written `SharedArrayBuffer` queue is claimed
before the scheduled 1/2/4/8 Worker benchmark.

The implementation follows the per-slot sequence design of bounded MPMC queues such as
[Rigtorp's MPMCQueue](https://github.com/rigtorp/MPMCQueue), adapted to WebAssembly shared memory's
sequentially consistent scalar atomics. A deterministic Deno test runs two concurrent producers and
two consumers over 4,096 unique handles. The memory profile performs 1,000 full 4,096-handle cycles
with a fixed one-page backing memory and no live allocations.

## Generation-tagged slot map

`SharedSlotMap` allocates fixed-size shared payloads and identifies them with a `bigint` handle. The
low 32 bits contain the slot index and the high bits contain a 31-bit generation. Allocation and
release atomically transition one state word between `generation` and `allocated | generation`;
release increments the generation before the slot can be reused.

```ts
import { SharedBuffer, SharedSlotMap } from "@mizchi/jsimd/shared-buffer";

using shared = await SharedBuffer.create({ maxWorkers: 4 });
const slots = SharedSlotMap.initialize(shared, 0, {
  capacity: 1_024,
  payloadByteLength: 48,
});

{
  using slot = slots.allocate();
  slot.uint32Array(0, 2).set([taskKind, taskId]);
  consumeLocally(slot.handle);
} // release advances the generation
```

`get(handle)` returns a generation-checking non-owning view and `release(handle)` supports explicit
ownership transfer. A retained view rejects access after release, and an old handle cannot address
the next occupant of the same slot. The generation wraps after 2,147,483,647 releases of one slot;
applications requiring stronger indefinite ABA protection need a wider state representation or an
epoch policy.

Payloads are padded to a 16-byte stride but their logical bounds remain exact. Reused payloads are
not zero-filled. `get` only validates the generation at each view request; it does not pin the slot,
so the owner must not release concurrently with a reader. The allocator scans atomic state words and
is best for bounded handle storage, not as a replacement for local JavaScript object allocation.

The concurrent test has four Workers hold all 128 slots simultaneously and verifies unique handles.
The memory profile runs 1,000 rounds of 64 allocate/write/release operations with zero live slots
and a fixed one-page backing memory. `SpscRingBufferU64` and `MpmcRingBufferU64` transport complete
handles; the browser fixture sends a slot handle through the MPMC u64 queue, mutates its payload in
a Worker, and returns the same handle through the queue.

Separate u64 queue profiles each run 1,000 full enqueue/dequeue cycles over 2,048 handles. Both keep
the one-page backing memory fixed, report zero live allocations, and pass the allocator and host
memory plateau checks. This is a leak/reuse check, not a throughput claim; bigint conversion makes
u64 scalar and bulk operations more expensive than the equivalent u32 path.

## Atomic dense bitmap

`AtomicDenseBitmap` is a fixed-universe shared bitmap for linearizable point operations. It is a
non-owning view; keep the surrounding `SharedBuffer` lease in a `using` declaration.

```ts
import { AtomicDenseBitmap, SharedBuffer } from "@mizchi/jsimd/shared-buffer";

using shared = await SharedBuffer.create({ maxWorkers: 4 });
const claimed = AtomicDenseBitmap.initialize(shared, 0, 100_000);

if (!claimed.testAndSet(taskId)) {
  // This Worker changed the bit from clear to set.
}
```

`set`, `clear`, and `toggle` use scalar atomic RMW. `testAndSet` and `testAndClear` return the
linearized prior state, and `has` uses an atomic load. Four contending Workers are tested against
the same bit: exactly one observes the clear-to-set transition and exactly one observes
set-to-clear.

There is deliberately no concurrent `count`, `values`, or SIMD set algebra API. Reading multiple
words while writers mutate them would not produce a consistent snapshot. Use a later `ShardedBitmap`
reduction or immutable snapshot when a coherent bulk result is required. `AtomicDenseBitmap` does
not claim to beat equivalent hand-written `SharedArrayBuffer` + `Atomics` code; it supplies a
validated attachable layout and precise operation semantics. Its memory profile runs 1,000 full
set/clear cycles over 4,096 bits in a 32,768-bit universe with fixed backing memory and passes
allocator/host plateau checks.

## Sharded bitmap

`ShardedBitmap` gives each writer exclusive ownership of a cache-line-isolated dense shard. Shard
leases use `using`; point updates inside an owned shard are ordinary non-atomic writes. After an
external `SharedBarrier`, a coordinator reduces all shards with one Wasm SIMD OR or AND pass.

```ts
import { ShardedBitmap, SharedBuffer } from "@mizchi/jsimd/shared-buffer";

using shared = await SharedBuffer.create({ maxWorkers: 5 });
const bitmaps = ShardedBitmap.initialize(shared, 0, {
  capacity: 1_000_000,
  shardCount: 4,
});

// Worker-local phase
using shard = bitmaps.claimShard(workerIndex);
shard.set(entityId);
barrier.arriveAndWait();

// Coordinator after the barrier
const combined = bitmaps.reduceOr();
combined.has(entityId);
```

`reduceOr()` and `reduceAnd()` return a generation-checked non-owning result view. A later reduction
overwrites the same result region and makes the older view stale. The library prevents concurrent
reducers, but it cannot infer whether writers reached a barrier; calling reduction concurrently with
shard mutation is outside the contract. Shard and reduction roles use generation-tagged tokens, so a
later Worker can replace an owner left by a reclaimed generation.

On Node 24.12 / Apple M5, reducing four resident 1,048,576-bit shards took 0.0122 ms for OR and
0.0120 ms for AND. Equivalent scalar loops over shared `Uint32Array` took 0.0929 ms and 0.0956 ms,
making the SIMD reductions 7.62x and 7.96x faster. This excludes Worker startup and barrier latency;
small bitmaps or one-shot work may not amortize coordination. The memory profile performs 1,000
mutate/reduce cycles with fixed shared memory and generation-invalidated result views.

## Striped accumulators

`StripedCounter` and `StripedHistogram` give each Worker an exclusive cache-line-isolated stripe.
Updates are non-atomic inside the lease; a coordinator calls `sum()` or `reduceInto()` only after an
external barrier. Counts use wrapping u32 arithmetic.

```ts
import { SharedBuffer, StripedHistogram } from "@mizchi/jsimd/shared-buffer";

using shared = await SharedBuffer.create({ maxWorkers: 5 });
const histogram = StripedHistogram.initialize(shared, 0, {
  bucketCount: 32_768,
  stripeCount: 4,
});

// One exclusive stripe per Worker. Batch locally to avoid per-event API overhead.
using stripe = histogram.claimStripe(workerIndex);
stripe.setFrom(workerLocalCounts);
barrier.arriveAndWait();

// Coordinator after the barrier.
const counts = new Uint32Array(histogram.bucketCount);
histogram.reduceInto(counts);
```

The recorded four-stripe, 32,768-bucket SIMD sum took 0.0173 ms versus 0.1203 ms for a scalar loop
over the same shared typed arrays: 6.96x faster. Worker startup and barrier latency are excluded.
For a single counter or a small histogram, coordination and the Wasm boundary can outweigh the
reduction; direct `Atomics` may be simpler. A separate `StripedDenseBitmap` alias is not exported
because `ShardedBitmap` already has the same worker-local bitmap and OR/AND reduction semantics. The
memory profile passes allocator, host, and live-resource plateau checks over 1,000 cycles.

## Versioned publication

`VersionedBuffer` publishes one of two fixed-size byte slots atomically. Readers hold a disposable
guard; the writer cannot reuse a retired slot until all guards for it are released.

```ts
import { SharedBuffer, VersionedBuffer } from "@mizchi/jsimd/shared-buffer";

using shared = await SharedBuffer.create();
const versions = VersionedBuffer.initialize(shared, 0, 4096);
{
  using writer = versions.beginWrite();
  writer.bytes.set(nextIndex);
  writer.publish();
}

using snapshot = versions.acquire();
scanImmutableBytes(snapshot.bytes);
```

The snapshot byte view is read-only by contract, although JavaScript typed arrays cannot enforce
that at the type level. `tryBeginWrite()` returns `undefined` while the inactive slot still has
readers; `beginWrite()` throws instead of blocking the browser main thread. This structure avoids a
reader-side payload copy, but doubles payload storage and permits only one writer. `SnapshotCell` is
not a second alias for the same layout. The memory profile passes all plateau checks over 1,000
publish/acquire/release cycles.

Writer ownership is generation-tagged and recoverable. Reader counts are currently anonymous: if a
Worker is forcibly terminated while holding a snapshot, that retired slot remains pinned. Do not use
forced termination while guards are live; per-worker reader registration is deferred until a
consumer requires recoverable read-side publication.

## Work-stealing deque

`WorkStealingDequeU32` is a fixed-capacity Chase-Lev deque for u32 task handles. Its disposable
owner pushes and pops at the bottom; any attached Worker can steal from the top with CAS.

```ts
import { SharedBuffer, WorkStealingDequeU32 } from "@mizchi/jsimd/shared-buffer";

using shared = await SharedBuffer.create({ maxWorkers: 8 });
const deque = WorkStealingDequeU32.initialize(shared, 0, 1024);
using owner = deque.owner();
owner.tryPush(taskHandle);

// Another Worker attached to the same SharedBuffer.
const task = deque.trySteal();
```

Capacity must be a power of two and cannot grow. The implementation is tested with four concurrent
thieves, exact-once delivery, and u32 counter rollover. No speedup over `Array.push/pop` is claimed:
a JavaScript array is better for one realm, while this deque exists for shared-memory scheduling.
The end-to-end histogram benchmark below measures the same ownership/reduction design against
`postMessage`; a dedicated irregular-task scheduling workload remains necessary before claiming a
deque throughput advantage. Its 1,000-cycle owner lease and full-capacity push/pop memory profile
passes all plateau checks.

The end-to-end 4,096-bucket workload under
[`experiments/shared-buffer`](../../experiments/shared-buffer) shows the actual trade-off: bulk
striped publication was 2% faster than `postMessage` at two Workers and 5% faster at four, but 4%
slower at one and 29% slower at eight on Apple M5 / Deno 2.6.4. Per-event `increment()` is a
convenience, not the performance contract; use `setFrom()` after local batching.

## Atomic and SIMD boundary

Point updates use JavaScript `Atomics` directly on `uint32Array` views. A measured Wasm point
wrapper was 3.34x slower and was removed before publication. `fillUint32` uses `i32x4.splat` and
`v128.store`, but is owner-only: concurrent access requires an external lock, barrier,
shard-ownership rule, or immutable snapshot. There is no atomic `v128` operation, so a SIMD bulk
mutation is deliberately not described as linearizable.

Recorded with Vitest 4.1.11 / Node 24.12 / Apple M5 over one owner-only shared region:

| words   | Wasm SIMD fill | `Shared Uint32Array.fill` | result       |
| :------ | -------------: | ------------------------: | :----------- |
| 64      |     0.00005 ms |                0.00007 ms | 1.30x faster |
| 1,024   |     0.00012 ms |                0.00038 ms | 3.22x faster |
| 262,144 |      0.0209 ms |                 0.0771 ms | 3.69x faster |

The broader performance contract is zero-copy shared attachment plus bulk SIMD under an ownership
rule, not a claim that a single atomic operation beats JavaScript `Atomics`. The recorded
1/2/4/8-Worker comparison includes `postMessage`, direct shared atomics, striped SIMD reduction,
single-thread execution, p99 latency, hot-key contention, and packed-versus-padded false sharing.

```sh
pnpm bench:shared-buffer
pnpm bench:record:shared-buffer
pnpm bench:compare:shared-buffer
```

The benchmark source and committed baseline are under
[`experiments/shared-buffer`](../../experiments/shared-buffer).

Browsers require the security conditions that expose `SharedArrayBuffer`; applications should test
`crossOriginIsolated` and `supportsSharedWebAssemblyMemory()` before creating a worker pool. Worker
threads may block with `Atomics.wait`, while browser main-thread APIs must remain asynchronous.

Sources:

- [WebAssembly Threads overview](https://github.com/WebAssembly/threads/blob/main/proposals/threads/Overview.md#atomic-memory-accesses)
- [MDN: SharedArrayBuffer security requirements](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer#security_requirements)
- [MDN: WebAssembly.Memory](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/WebAssembly/Memory/Memory)
- [Chase and Lev: Dynamic Circular Work-Stealing Deque](https://doi.org/10.1145/1073970.1073974)

## Standalone build size

The isolated Vite 8.2 fixture emits 26.65 kB gzip of JavaScript across its separate main and Worker
chunks plus one 0.33 kB gzip shared-memory Wasm asset. No unrelated jsimd Wasm is included. The
duplicated wrapper cost is a current trade-off of compiling and attaching one kernel instance in
each realm.

Files:

- `mod.ts`: ABI validation, worker leases, shared views, and atomic/bulk operations
- `ownership.ts`: generation-aware exclusive-owner claim and release primitives
- `sync.ts`: cache-line-padded mutex, barrier, and wait-group views
- `block-pool.ts`: fixed-size shared allocator and disposable block leases
- `spsc-ring.ts` / `spsc-ring-u64.ts`: u32/u64 SPSC transport and disposable roles
- `mpmc-ring.ts` / `mpmc-ring-u64.ts`: sequence-numbered u32/u64 MPMC transport
- `slot-map.ts`: fixed-payload allocator with generation-tagged handles
- `atomic-dense-bitmap.ts`: fixed-universe linearizable scalar bitmap updates
- `sharded-bitmap.ts`: exclusive dense shards and barrier-delimited SIMD reduction
- `striped-accumulator.ts`: worker-local u32 counters/histograms and SIMD sum reduction
- `versioned-buffer.ts`: guarded double-buffer publication and safe slot reuse
- `work-stealing-deque.ts`: fixed-capacity u32 Chase-Lev task deque
- `*_test.ts`: colocated ABI, synchronization, allocator, and queue tests
- `kernels.wat`: imported shared memory and owner-only SIMD fill/copy kernels
- `kernels.d.wasm.ts`: typed Wasm asset contract
- `kernels.wasm`: generated, stripped, validated with threads/SIMD, and Git-ignored
