import { indexOf } from "../../packages/jsimd/src/bytes/mod.ts";

document.body.textContent = String(indexOf(new Uint8Array(256), 1));
