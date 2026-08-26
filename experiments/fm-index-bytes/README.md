# FmIndexBytes experiment

The query suite counts 512 eight-byte patterns over 32,768 bytes, with half misses. It compares the
resident FM-index with overlapping `String#indexOf` and scalar `Uint8Array` scans. Construction is
measured separately over 8,192 bytes.

Recorded on Apple M5 / Node 24.12: `countMany` took 0.4348 ms, overlapping string search took 2.9848
ms, and scalar byte search took 32.9361 ms. Materializing 233,657 positions with `locateMany` took
324.8 ms. Building the 8,192-byte index took 3.48 ms.
