# `@mizchi/jsimd-shared`

SharedArrayBuffer and Web Worker primitives extracted from `@mizchi/jsimd/shared-buffer`.

```ts
import { SharedBuffer, SpscRingBufferU32 } from "@mizchi/jsimd-shared";

using shared = await SharedBuffer.create({ maxWorkers: 2 });
const ring = SpscRingBufferU32.initialize(shared, 0, 64);
```

`SharedSelectionMask` publishes a packed row selection once and lets downstream Workers consume the
same generation without materializing row IDs in JavaScript. The mask itself is a non-owning view;
the `SharedBuffer` and exclusive writer lease use `using`.

```ts
import { SharedBuffer, SharedSelectionMask } from "@mizchi/jsimd-shared";

using shared = await SharedBuffer.create({ maxWorkers: 4 });
const mask = SharedSelectionMask.initialize(shared, 0, rowCount);
let generation: number;
{
  using writer = mask.claimWriter();
  writer.clearAll();
  // A SIMD predicate kernel may write packed words at writer.dataByteOffset.
  writer.set(10);
  writer.set(42);
  generation = writer.publish();
}
worker.postMessage({ memory: shared.memory, generation });
```

Only one writer may mutate the mask. Publishing invalidates older views, clears padded tail words,
and advances a generation checked by every reader. Synchronization between a published generation
and downstream tasks remains the caller's responsibility.

When several Workers attach at once, compile the runtime once in the coordinator and include the
module in each initialization message:

```ts
import { compileSharedBufferModule, SharedBuffer } from "@mizchi/jsimd-shared";

const module = await compileSharedBufferModule();
using shared = await SharedBuffer.create({ maxWorkers: 5, module });
worker.postMessage({ memory: shared.memory, module });

// In each Worker:
using attached = await SharedBuffer.attach(event.data.memory, { module: event.data.module });
```

The first release is a compatibility facade. The implementation stays in `@mizchi/jsimd` until
consumers have migrated, so the existing subpath remains source and runtime compatible.

Browsers require WebAssembly threads, SharedArrayBuffer, and cross-origin isolation. Node.js 24.5+
and Deno 2.6+ are supported.
