import { BlockedVectorArray } from "../../packages/jsimd/src/blocked-vector-array/mod.ts";

using vectors = BlockedVectorArray.from(
  new Float32Array([0, 1, 1, 0, 2, 2]),
  3,
  2,
);
const distances = new Float32Array(vectors.length);
vectors.squaredDistanceMany(new Float32Array([0, 0]), distances);
vectors.l1DistanceMany(new Float32Array([0, 0]), distances);
vectors.innerProductMany(new Float32Array([0, 0]), distances);
const ids = new Uint32Array(2);
const nearest = new Float32Array(2);
vectors.topKInto(new Float32Array([0, 0]), ids, nearest);
vectors.topKInnerProductInto(new Float32Array([0, 0]), ids, nearest);
document.body.textContent = `${distances.join(",")}; ${ids.join(",")}`;
