import { bench, describe } from "vitest";
import { jsonTokenStarts } from "../../packages/jsimd/src/json/mod.ts";

function scalarJsonTokenStarts(input: Uint8Array): Uint32Array {
  const starts: number[] = [];
  let inString = false;
  let escaped = false;
  let previousIsAtom = false;
  for (let offset = 0; offset < input.length; offset++) {
    const byte = input[offset]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (byte === 92) escaped = true;
      else if (byte === 34) {
        starts.push(offset);
        inString = false;
      }
      previousIsAtom = false;
    } else if (byte === 34) {
      starts.push(offset);
      inString = true;
      previousIsAtom = false;
    } else if (
      byte === 123 || byte === 125 || byte === 91 || byte === 93 || byte === 58 || byte === 44
    ) {
      starts.push(offset);
      previousIsAtom = false;
    } else if (byte === 32 || byte === 9 || byte === 10 || byte === 13) {
      previousIsAtom = false;
    } else {
      if (!previousIsAtom) starts.push(offset);
      previousIsAtom = true;
    }
  }
  return new Uint32Array(starts);
}

const encoder = new TextEncoder();
describe.each(
  [
    ["mixed", `[${new Array(1000).fill('{"id":123,"ok":true,"name":"moonbit"}').join(",")}]`],
    ["dense", `[${new Array(10_000).fill("[0,1]").join(",")}]`],
    ["strings", JSON.stringify(new Array(1000).fill("a".repeat(64) + '\\"tail'))],
  ] as const,
)("JSON lexer %s", (_name, source) => {
  const input = encoder.encode(source);
  bench("Wasm SIMD jsonTokenStarts", () => {
    jsonTokenStarts(input);
  });
  bench("scalar JSON lexer", () => {
    scalarJsonTokenStarts(input);
  });
});
