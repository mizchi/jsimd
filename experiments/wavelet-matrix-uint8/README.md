# WaveletMatrixUint8 experiment

The retained benchmark compares 4,096 batched rank and access queries over 262,144 bytes with the
32-level matrix and direct `Uint8Array` access. Construction is excluded.

Recorded on Apple M5 / Node 24.12: byte `rankMany` took 0.2742 ms versus 1.3162 ms for the 32-level
matrix; byte `accessMany` took 0.2766 ms versus 1.3031 ms. Direct `Uint8Array` access took 0.0115
ms.
