import { decodeUint32BE } from "../../packages/jsimd/src/endian/mod.ts";

document.body.textContent = String(decodeUint32BE(new Uint8Array(256))[0]);
