import { WaveletMatrixUint8 } from "../../src/wavelet-matrix-uint8/mod.ts";

using bytes = WaveletMatrixUint8.from(new TextEncoder().encode("banana"));
document.body.textContent = String(bytes.rank(97, bytes.length));
