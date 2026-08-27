import { WaveletMatrixUint32 } from "../../packages/jsimd/src/wavelet-matrix-uint32/mod.ts";

using values = WaveletMatrixUint32.from([3, 1, 4, 1, 5, 9]);
document.body.textContent = String(values.quantile(0, values.length, 3));
