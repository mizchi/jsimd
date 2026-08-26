import { SimdFloat32Vector } from "../../src/f32-vector/mod.ts";

using left = SimdFloat32Vector.from([1, 2, 3, 4]);
using right = SimdFloat32Vector.from([2, 4, 6, 8]);
document.body.textContent = `${left.dot(right)},${left.squaredDistance(right)},${
  left.cosineSimilarity(right)
}`;
