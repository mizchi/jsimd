import { afterAll, bench, describe } from "vitest";
import { FingerprintGroup16, FingerprintTable16 } from "../../src/fingerprint-group16/mod.ts";

let sink = 0;
const controls = Uint8Array.of(7, 1, 7, 0x80, 0xfe, 7, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12);
const fingerprints = Uint8Array.from({ length: 131_072 }, (_, index) => index & 0x7f);
const output = new Uint16Array(fingerprints.length);

function scalarMask(fingerprint: number): number {
  let mask = 0;
  for (let lane = 0; lane < 16; lane++) mask |= Number(controls[lane] === fingerprint) << lane;
  return mask;
}

describe("FingerprintGroup16", () => {
  const group = FingerprintGroup16.from(controls);
  afterAll(() => group[Symbol.dispose]());

  bench("Wasm matchMask x1024", () => {
    let total = 0;
    for (let index = 0; index < 1_024; index++) total ^= group.matchMask(index & 0x7f);
    sink ^= total;
  });
  bench("JS scalar mask x1024", () => {
    let total = 0;
    for (let index = 0; index < 1_024; index++) total ^= scalarMask(index & 0x7f);
    sink ^= total;
  });
  bench("Wasm matchMany x131072", () => {
    group.matchMany(fingerprints, output);
    sink ^= output[0]!;
  });
  bench("JS scalar masks x131072", () => {
    for (let index = 0; index < fingerprints.length; index++) {
      output[index] = scalarMask(fingerprints[index]!);
    }
    sink ^= output[0]!;
  });
});

describe("FingerprintTable16 batch primary probes", () => {
  const capacity = 65_536;
  const table = new FingerprintTable16(capacity);
  for (let slot = 0; slot < capacity; slot += 3) table.setControl(slot, slot & 0x7f);
  const hashes = Uint32Array.from(
    { length: 131_072 },
    (_, index) => ((index & 0x7f) << 25) | Math.imul(index, 65_537),
  );
  const groups = new Uint32Array(hashes.length);
  const matches = new Uint16Array(hashes.length);
  const empty = new Uint16Array(hashes.length);
  const deleted = new Uint16Array(hashes.length);
  const tableControls = new Uint8Array(capacity).fill(0x80);
  for (let slot = 0; slot < capacity; slot += 3) tableControls[slot] = slot & 0x7f;

  afterAll(() => table[Symbol.dispose]());

  bench("Wasm table probeMany x131072", () => {
    table.probeMany(hashes, groups, matches, empty, deleted);
    sink ^= matches[0]!;
  });
  bench("JS table masks x131072", () => {
    for (let index = 0; index < hashes.length; index++) {
      const hash = hashes[index]!;
      const offset = (hash & (capacity - 1)) & ~15;
      const fingerprint = hash >>> 25;
      let matchMask = 0;
      let emptyMask = 0;
      for (let lane = 0; lane < 16; lane++) {
        const control = tableControls[offset + lane]!;
        matchMask |= Number(control === fingerprint) << lane;
        emptyMask |= Number(control === 0x80) << lane;
      }
      groups[index] = offset;
      matches[index] = matchMask;
      empty[index] = emptyMask;
      deleted[index] = 0;
    }
    sink ^= matches[0]!;
  });
});
