import { afterAll, bench, describe } from "vitest";
import { FmIndexBytes } from "../../packages/jsimd/src/fm-index-bytes/mod.ts";

const LENGTH = 32_768;
const QUERY_COUNT = 512;
const PATTERN_LENGTH = 8;
const text = Uint8Array.from(
  { length: LENGTH },
  (_, index) => 97 + ((index * 17 + (index >>> 5)) % 23),
);
const textString = String.fromCharCode(...text);
const offsets = new Uint32Array(QUERY_COUNT + 1);
const patterns = new Uint8Array(QUERY_COUNT * PATTERN_LENGTH);
const patternStrings: string[] = [];
for (let query = 0; query < QUERY_COUNT; query++) {
  const start = (query * 65_537) & (LENGTH - 1);
  const pattern = text.slice(start, start + PATTERN_LENGTH);
  if ((query & 1) !== 0) pattern[0] = 255;
  patterns.set(pattern, query * PATTERN_LENGTH);
  offsets[query + 1] = (query + 1) * PATTERN_LENGTH;
  patternStrings.push(String.fromCharCode(...pattern));
}
let sink = 0;

describe("FmIndexBytes repeated count", () => {
  const index = FmIndexBytes.from(text);
  const output = new Uint32Array(QUERY_COUNT);
  afterAll(() => index[Symbol.dispose]());
  bench("FM countMany x512", () => {
    sink ^= index.countMany(patterns, offsets, output)[0]!;
  });
  bench("FM locateMany x512", () => {
    sink ^= index.locateMany(patterns, offsets).positions.length;
  });
  bench("String.indexOf overlap count x512", () => {
    let total = 0;
    for (const pattern of patternStrings) {
      let position = -1;
      while ((position = textString.indexOf(pattern, position + 1)) >= 0) total++;
    }
    sink ^= total;
  });
  bench("Uint8Array scalar count x512", () => {
    let total = 0;
    for (let query = 0; query < QUERY_COUNT; query++) {
      const pattern = patterns.subarray(offsets[query], offsets[query + 1]);
      outer: for (let start = 0; start + pattern.length <= text.length; start++) {
        for (let byte = 0; byte < pattern.length; byte++) {
          if (text[start + byte] !== pattern[byte]) continue outer;
        }
        total++;
      }
    }
    sink ^= total;
  });
});

describe("FmIndexBytes construction", () => {
  const buildText = text.subarray(0, 8_192);
  bench("FM build 8192", () => {
    using index = FmIndexBytes.from(buildText);
    sink ^= index.length;
  });
});
