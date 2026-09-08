import {
  compare,
  equals,
  indexOf,
  indexOfNonAscii,
  lastIndexOf,
} from "../../packages/jsimd/src/bytes/mod.ts";

const input = new TextEncoder().encode("MoonBit + Wasm SIMD");
document.querySelector("#app")!.textContent = JSON.stringify({
  ascii: indexOfNonAscii(input) < 0,
  equal: equals(input, input.slice()),
  first: indexOf(input, "M".charCodeAt(0)),
  jsimdAt: indexOf(input, new TextEncoder().encode("SIMD")),
  last: lastIndexOf(input, "M".charCodeAt(0)),
  order: compare(input, input.slice()),
});
