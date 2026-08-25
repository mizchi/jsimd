import { findByte } from "../../src/bytes/mod.ts";

document.body.textContent = String(findByte(new Uint8Array(256), 1));
