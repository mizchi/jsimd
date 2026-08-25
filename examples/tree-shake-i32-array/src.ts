import { SimdInt32Array } from "../../src/i32-array/mod.ts";

using values = SimdInt32Array.from([1, 2, 3, 4]);
document.body.textContent = String(values.sum());
