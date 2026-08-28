import { UltraLogLogU32 } from "../../packages/jsimd/src/ultra-log-log/mod.ts";

using sketch = UltraLogLogU32.from(Uint32Array.of(10, 20, 20, 30), 8);
document.querySelector<HTMLDivElement>("#app")!.textContent = String(sketch.estimate());
