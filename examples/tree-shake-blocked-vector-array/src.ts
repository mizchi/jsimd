import { BlockedVectorArray } from "../../src/blocked-vector-array/mod.ts";

using vectors = BlockedVectorArray.from(
  new Float32Array([0, 1, 1, 0, 2, 2]),
  3,
  2,
);
const distances = new Float32Array(vectors.length);
vectors.squaredDistanceMany(new Float32Array([0, 0]), distances);
document.body.textContent = distances.join(",");
