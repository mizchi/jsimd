import { afterAll, bench, describe } from "vitest";
import { BlockedBloomFilterU32 } from "../../packages/jsimd/src/blocked-bloom-filter/mod.ts";

const KEY_COUNT = 262_144;
const QUERY_COUNT = 1_048_576;
const BITS_PER_KEY = 12;
let sink = 0;

const keys = Uint32Array.from(
  { length: KEY_COUNT },
  (_, index) => Math.imul(index, 0x9e37_79b1) >>> 0,
);
const misses = Uint32Array.from(
  { length: QUERY_COUNT },
  (_, index) => (Math.imul(index, 0x85eb_ca6b) ^ 0x8000_0000) >>> 0,
);
const exact = new Set<number>(keys);
// Make the negative workload exact even if the two generated domains overlap.
const negativeQueries = Uint32Array.from(misses.filter((key) => !exact.has(key)));
const wasmOutput = new Uint8Array(negativeQueries.length);
const jsOutput = new Uint8Array(negativeQueries.length);
const mixed90 = Uint32Array.from(
  { length: QUERY_COUNT },
  (_, index) => index % 10 === 0 ? keys[index % keys.length]! : negativeQueries[index]!,
);
const mixed50 = Uint32Array.from(
  { length: QUERY_COUNT },
  (_, index) => index % 2 === 0 ? keys[index % keys.length]! : negativeQueries[index]!,
);
const mixed10 = Uint32Array.from(
  { length: QUERY_COUNT },
  (_, index) => index % 10 === 0 ? negativeQueries[index]! : keys[index % keys.length]!,
);
const allHits = Uint32Array.from({ length: QUERY_COUNT }, (_, index) => keys[index % keys.length]!);
const mixedOutput = new Uint8Array(QUERY_COUNT);

class ScalarBlockedBloom {
  readonly blockCount: number;
  readonly words: Uint32Array;

  constructor(expectedItems: number, bitsPerKey: number) {
    this.blockCount = Math.max(1, Math.ceil(expectedItems * bitsPerKey / 128));
    this.words = new Uint32Array(this.blockCount * 4);
  }

  addMany(input: Uint32Array): void {
    for (let index = 0; index < input.length; index++) {
      const key = input[index]!;
      const hash = mix32(key);
      const bitHash = mix32(hash ^ 0x9e37_79b9);
      const offset = (hash % this.blockCount) * 4;
      this.words[offset] |= 1 << (bitHash & 31);
      this.words[offset + 1] |= 1 << ((bitHash >>> 8) & 31);
      this.words[offset + 2] |= 1 << ((bitHash >>> 16) & 31);
      this.words[offset + 3] |= 1 << ((bitHash >>> 24) & 31);
    }
  }

  mayContainMany(input: Uint32Array, output: Uint8Array): number {
    let count = 0;
    for (let index = 0; index < input.length; index++) {
      const hash = mix32(input[index]!);
      const bitHash = mix32(hash ^ 0x9e37_79b9);
      const offset = (hash % this.blockCount) * 4;
      const present = (this.words[offset]! & (1 << (bitHash & 31))) !== 0 &&
        (this.words[offset + 1]! & (1 << ((bitHash >>> 8) & 31))) !== 0 &&
        (this.words[offset + 2]! & (1 << ((bitHash >>> 16) & 31))) !== 0 &&
        (this.words[offset + 3]! & (1 << ((bitHash >>> 24) & 31))) !== 0;
      output[index] = Number(present);
      count += Number(present);
    }
    return count;
  }
}

function mix32(value: number): number {
  value = (value ^ (value >>> 16)) >>> 0;
  value = Math.imul(value, 0x7feb_352d) >>> 0;
  value = (value ^ (value >>> 15)) >>> 0;
  value = Math.imul(value, 0x846c_a68b) >>> 0;
  return (value ^ (value >>> 16)) >>> 0;
}

function verifyCandidates(input: Uint32Array, output: Uint8Array): number {
  let found = 0;
  for (let index = 0; index < output.length; index++) {
    if (output[index] !== 0 && exact.has(input[index]!)) found++;
  }
  return found;
}

describe("blocked Bloom over 262K keys and 1M negative queries", () => {
  const wasm = BlockedBloomFilterU32.from(keys, BITS_PER_KEY);
  const scalar = new ScalarBlockedBloom(KEY_COUNT, BITS_PER_KEY);
  scalar.addMany(keys);
  const falsePositives = wasm.mayContainMany(negativeQueries, wasmOutput);
  const scalarFalsePositives = scalar.mayContainMany(negativeQueries, jsOutput);
  if (falsePositives !== scalarFalsePositives) throw new Error("Bloom implementations disagree");

  afterAll(() => wasm[Symbol.dispose]());

  bench("Wasm Bloom mayContainMany", () => {
    sink ^= wasm.mayContainMany(negativeQueries, wasmOutput);
  });
  bench("scalar JS Bloom mayContainMany", () => {
    sink ^= scalar.mayContainMany(negativeQueries, jsOutput);
  });
  bench("Wasm Bloom then Set verification", () => {
    wasm.mayContainMany(negativeQueries, wasmOutput);
    sink ^= verifyCandidates(negativeQueries, wasmOutput);
  });
  bench("scalar JS Bloom then Set verification", () => {
    scalar.mayContainMany(negativeQueries, jsOutput);
    sink ^= verifyCandidates(negativeQueries, jsOutput);
  });
  bench("Set.has over every negative", () => {
    let found = 0;
    for (let index = 0; index < negativeQueries.length; index++) {
      found += Number(exact.has(negativeQueries[index]!));
    }
    sink ^= found;
  });
});

describe("blocked Bloom end-to-end hit-ratio crossover", () => {
  const wasm = BlockedBloomFilterU32.from(keys, BITS_PER_KEY);
  afterAll(() => wasm[Symbol.dispose]());

  bench("Bloom + Set with 90% misses", () => {
    wasm.mayContainMany(mixed90, mixedOutput);
    sink ^= verifyCandidates(mixed90, mixedOutput);
  });
  bench("Set.has with 90% misses", () => {
    let found = 0;
    for (let index = 0; index < mixed90.length; index++) {
      found += Number(exact.has(mixed90[index]!));
    }
    sink ^= found;
  });
  bench("Bloom + Set with 50% misses", () => {
    wasm.mayContainMany(mixed50, mixedOutput);
    sink ^= verifyCandidates(mixed50, mixedOutput);
  });
  bench("Set.has with 50% misses", () => {
    let found = 0;
    for (let index = 0; index < mixed50.length; index++) {
      found += Number(exact.has(mixed50[index]!));
    }
    sink ^= found;
  });
  bench("Bloom + Set with 10% misses", () => {
    wasm.mayContainMany(mixed10, mixedOutput);
    sink ^= verifyCandidates(mixed10, mixedOutput);
  });
  bench("Set.has with 10% misses", () => {
    let found = 0;
    for (let index = 0; index < mixed10.length; index++) {
      found += Number(exact.has(mixed10[index]!));
    }
    sink ^= found;
  });
  bench("Bloom + Set with all hits", () => {
    wasm.mayContainMany(allHits, mixedOutput);
    sink ^= verifyCandidates(allHits, mixedOutput);
  });
  bench("Set.has with all hits", () => {
    let found = 0;
    for (let index = 0; index < allHits.length; index++) {
      found += Number(exact.has(allHits[index]!));
    }
    sink ^= found;
  });
});

describe("blocked Bloom construction over 262K keys", () => {
  bench("Wasm Bloom construction", () => {
    using filter = BlockedBloomFilterU32.from(keys, BITS_PER_KEY);
    sink ^= filter.blockCount;
  });
  bench("scalar JS Bloom construction", () => {
    const filter = new ScalarBlockedBloom(KEY_COUNT, BITS_PER_KEY);
    filter.addMany(keys);
    sink ^= filter.blockCount;
  });
  bench("Set construction", () => {
    sink ^= new Set<number>(keys).size;
  });
});
