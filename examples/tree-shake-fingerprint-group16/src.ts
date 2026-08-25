import { FingerprintGroup16 } from "../../src/fingerprint-group16/mod.ts";

using group = FingerprintGroup16.from(Uint8Array.from({ length: 16 }, (_, index) => index & 3));
document.body.textContent = String(group.matchMask(2));
