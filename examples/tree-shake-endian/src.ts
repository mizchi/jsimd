import { decodeUint32BE } from "../../src/endian/mod.ts";

document.body.textContent = String(decodeUint32BE(new Uint8Array(256))[0]);
