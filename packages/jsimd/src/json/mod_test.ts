import { jsonTokenStarts } from "../json/mod.ts";
import { assertEquals } from "../../test/assert.ts";

function scalarJsonTokenStarts(input: Uint8Array): Uint32Array {
  const starts: number[] = [];
  let inString = false;
  let escaped = false;
  let previousIsAtom = false;
  for (let offset = 0; offset < input.length; offset++) {
    const byte = input[offset]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (byte === 0x5c) escaped = true;
      else if (byte === 0x22) {
        starts.push(offset);
        inString = false;
      }
      previousIsAtom = false;
    } else if (byte === 0x22) {
      starts.push(offset);
      inString = true;
      previousIsAtom = false;
    } else if (
      byte === 0x7b || byte === 0x7d || byte === 0x5b || byte === 0x5d ||
      byte === 0x3a || byte === 0x2c
    ) {
      starts.push(offset);
      previousIsAtom = false;
    } else if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
      previousIsAtom = false;
    } else {
      if (!previousIsAtom) starts.push(offset);
      previousIsAtom = true;
    }
  }
  return new Uint32Array(starts);
}

Deno.test("jsonTokenStarts matches MoonBit scalar lexer", () => {
  const encoder = new TextEncoder();
  for (
    const source of [
      "",
      "null",
      ' { "a": [1, true, null] } ',
      '["x\\"y","\\\\",-12.5e+2]',
      '{"日本語":"値","emoji":"👀"}',
      '["1234567890123456",false,{"x":1}]',
    ]
  ) {
    const input = encoder.encode(source);
    assertEquals(
      Array.from(jsonTokenStarts(input)).join(","),
      Array.from(scalarJsonTokenStarts(input)).join(","),
      source,
    );
  }
  let state = 0x9e37_79b9;
  for (let trial = 0; trial < 200; trial++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const input = Uint8Array.from({ length: state % 512 }, () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state & 0xff;
    });
    assertEquals(
      Array.from(jsonTokenStarts(input)).join(","),
      Array.from(scalarJsonTokenStarts(input)).join(","),
      `random bytes trial=${trial}`,
    );
  }
});
