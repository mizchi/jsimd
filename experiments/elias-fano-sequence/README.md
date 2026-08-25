# EliasFanoSequence experiment

This experiment compares Elias–Fano with an uncompressed sorted `Uint32Array` and this package's
Stream-VByte `PackedDeltaUint32List` on identical strict-monotone datasets.

```sh
pnpm bench:elias-fano-sequence
pnpm bench:record:elias-fano-sequence
pnpm bench:compare:elias-fano-sequence
```

The committed baseline records point access, lower-bound rank, full decode, and encoded bytes.
