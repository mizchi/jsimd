import { BinaryVectorIndex, PdxFloat32Index } from "@mizchi/jsimd/binary-vector-index";

using index = BinaryVectorIndex.fromSignatures([
  new Uint8Array([0x00, 0x00]),
  new Uint8Array([0xff, 0x00]),
]);
const distances = new Uint32Array(index.length);
index.distanceMany(new Uint8Array([0, 0]), distances);
using exact = PdxFloat32Index.from(new Float32Array([0, 1, 1, 0]), 2, 2);
const exactDistances = new Float32Array(2);
exact.distanceMany(new Float32Array([0, 0]), exactDistances);
document.body.textContent = `${distances.join(",")}:${exactDistances.join(",")}`;
