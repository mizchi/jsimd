import {
  bytesEqual,
  findByte,
  findNonAscii,
  indexOfSubarray,
  jsonTokenStarts,
  lexicalCompare,
  reverseFindByte,
} from "../../mod.ts";

const input = new TextEncoder().encode("MoonBit + Wasm SIMD");
document.querySelector("#app")!.textContent = JSON.stringify({
  ascii: findNonAscii(input) < 0,
  equal: bytesEqual(input, input.slice()),
  first: findByte(input, "M".charCodeAt(0)),
  jsimdAt: indexOfSubarray(input, new TextEncoder().encode("SIMD")),
  jsonTokens: jsonTokenStarts(new TextEncoder().encode('{"ok":true}')).length,
  last: reverseFindByte(input, "M".charCodeAt(0)),
  order: lexicalCompare(input, input.slice()),
});
