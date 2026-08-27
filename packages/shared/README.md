# `@mizchi/jsimd-shared`

SharedArrayBuffer and Web Worker primitives extracted from `@mizchi/jsimd/shared-buffer`.

```ts
import { SharedBuffer, SpscRingBufferU32 } from "@mizchi/jsimd-shared";

using shared = await SharedBuffer.create({ maxWorkers: 2 });
const ring = SpscRingBufferU32.initialize(shared, 0, 64);
```

The first release is a compatibility facade. The implementation stays in `@mizchi/jsimd` until
consumers have migrated, so the existing subpath remains source and runtime compatible.

Browsers require WebAssembly threads, SharedArrayBuffer, and cross-origin isolation. Node.js 24.5+
and Deno 2.6+ are supported.
