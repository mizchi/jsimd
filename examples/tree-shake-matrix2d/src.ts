import { SimdMatrix2D } from "../../src/matrix2d/mod.ts";

using left = SimdMatrix2D.from(2, 2, [1, 2, 3, 4]);
using right = SimdMatrix2D.from(2, 2, [5, 6, 7, 8]);
using output = left.multiply(right);
document.body.textContent = String(output.get(0, 0));
