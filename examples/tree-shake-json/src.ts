import { jsonTokenStarts } from "../../packages/jsimd/src/json/mod.ts";

const input = new TextEncoder().encode('{"simd":true}');
document.body.textContent = String(jsonTokenStarts(input).length);
