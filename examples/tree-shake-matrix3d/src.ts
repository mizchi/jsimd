import { SimdMatrix3D } from "../../packages/jsimd/src/matrix3d/mod.ts";

using left = SimdMatrix3D.from(2, 2, 2, [1, 2, 3, 4, 2, 0, 1, 2]);
using right = SimdMatrix3D.from(2, 2, 2, [5, 6, 7, 8, 1, 3, 4, 2]);
using output = left.batchMultiply(right);
document.body.textContent = String(output.get(0, 0, 0));
