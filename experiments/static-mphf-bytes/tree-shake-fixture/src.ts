import { FrozenByteMapU32 } from "../prototype/mod.ts";

const encoder = new TextEncoder();
using keywords = FrozenByteMapU32.from([
  [encoder.encode("if"), 1],
  [encoder.encode("else"), 2],
]);
document.body.textContent = String(keywords.get(encoder.encode("else")));
