# Versioned snapshots

`serialize()` stores the resident frozen encoding in one self-describing `Uint8Array`.
`fromSnapshot()` validates the common magic/version/kind envelope, logical shape, payload lengths,
and structure-specific metadata before allocating Wasm memory. Snapshots own their bytes and remain
valid after the source structure leaves its `using` scope.

The initial format version supports `FmIndexBytes`, both wavelet matrices, `StaticMphfU32`,
`CompressedStringTable`, `EliasFanoSequence`, and `BinaryVectorIndex`. A version or structure-kind
mismatch is rejected rather than interpreted as a compatible layout. The byte format is intended for
persistence and transport, not as a stable in-memory view into Wasm.

## Build versus restore

Recorded with Vitest 4.1.11 / Node 24 / Apple M5. Snapshot size includes the envelope. Restore
copies the encoded payload into module-local Wasm memory; it does not alias the input bytes.

| structure / input                     |  snapshot |     build |  restore | speedup |
| :------------------------------------ | --------: | --------: | -------: | ------: |
| FM index / 8,192 bytes                |  12,144 B |  3.897 ms | 0.003 ms |  1,215x |
| byte wavelet matrix / 65,536 values   |  69,728 B |  0.603 ms | 0.028 ms |     21x |
| Uint32 wavelet matrix / 65,536 values | 278,816 B |  6.749 ms | 0.107 ms |     63x |
| MPHF / 16,384 keys                    |  49,184 B | 30.787 ms | 0.015 ms |  2,074x |
| string table / 16,384 paths           | 320,822 B |  5.690 ms | 0.057 ms |    100x |
| Elias–Fano / 65,536 values            |  39,140 B |  1.129 ms | 0.022 ms |     51x |
| binary vectors / 8,192 x 256 bits     | 262,176 B |  2.970 ms | 0.014 ms |    205x |

Elias–Fano rebuilds its small rank prefix from the restored high bits; the other structures copy
their complete query representation directly. Restore speed is ultimately memory-copy bound, so
larger snapshots and cold storage can dominate these resident microbenchmarks.

## Transport and memory

A 262,176-byte binary-vector snapshot was measured with Deno 2.5.4 and headless Chrome 152 on the
same machine:

| transport                   | mean round trip |  throughput |
| :-------------------------- | --------------: | ----------: |
| `structuredClone`           |        0.027 ms | 9,299 MiB/s |
| Worker `postMessage` copy   |        0.042 ms | 5,885 MiB/s |
| temporary-file write + read |        0.131 ms | 1,907 MiB/s |
| IndexedDB put + get         |        0.378 ms |   662 MiB/s |

These transport values are platform and storage dependent. They include the host copy or storage
round trip but not `fromSnapshot()`. Worker transfer lists can avoid a copy by relinquishing the
sender's buffer; this benchmark deliberately measures the reusable copy path.

Four memory-profile rounds restored and disposed 1,000–2,000 snapshots per structure. All seven
returned live Wasm allocations to baseline and reached a stable allocator/host-memory plateau. Peak
RSS above the post-construction baseline ranged from 0.2 MiB to 3.6 MiB; the maximum was the
Elias–Fano validation/rebuilt-rank scenario, and its final four samples were stable.

Run the reproducible measurements with:

```sh
pnpm bench:snapshots --run
just snapshot-transport
JSIMD_MEMORY_ROUNDS=4 node --no-warnings --expose-gc tools/profile-memory.ts \
  --scenario snapshot-binary-vector-index
```

The benchmark source is [`snapshots.bench.ts`](./snapshots.bench.ts), with the recorded Vitest
baseline in [`benchmarks/baseline.json`](./benchmarks/baseline.json).
