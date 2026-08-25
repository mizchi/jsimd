import { BinaryVectorIndex } from "@mizchi/jsimd/binary-vector-index";

using index = BinaryVectorIndex.fromSignatures([
  new Uint8Array([0x00, 0x00]),
  new Uint8Array([0xff, 0x00]),
]);
const distances = new Uint32Array(index.length);
index.distanceMany(new Uint8Array([0, 0]), distances);
document.body.textContent = distances.join(",");
