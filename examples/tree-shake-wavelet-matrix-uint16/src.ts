import { WaveletMatrixUint16 } from "../../packages/jsimd/src/wavelet-matrix-uint16/mod.ts";

using bytes = WaveletMatrixUint16.from(Uint16Array.of(98, 97, 110, 97, 110, 97));
document.body.textContent = String(bytes.rank(97, bytes.length));
