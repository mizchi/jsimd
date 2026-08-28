import { decodeUint32BE, decodeUint32LE } from "../endian/mod.ts";
import { assertEquals } from "../../test/assert.ts";

Deno.test("decodeUint32 decodes complete big- and little-endian batches", () => {
  const bigEndian = new Uint8Array([
    0x01,
    0x23,
    0x45,
    0x67,
    0x89,
    0xab,
    0xcd,
    0xef,
    0xff,
    0xff,
    0xff,
    0xff,
  ]);
  const littleEndian = new Uint8Array([
    0x67,
    0x45,
    0x23,
    0x01,
    0xef,
    0xcd,
    0xab,
    0x89,
    0xff,
    0xff,
    0xff,
    0xff,
  ]);
  assertEquals(
    [...decodeUint32BE(bigEndian)].join(","),
    "19088743,2309737967,4294967295",
    "big endian",
  );
  assertEquals(
    [...decodeUint32LE(littleEndian)].join(","),
    "19088743,2309737967,4294967295",
    "little endian",
  );
  assertEquals(decodeUint32BE(new Uint8Array()).length, 0, "empty batch");
});

Deno.test("decodeUint32 validates complete words and respects input views", () => {
  const storage = new Uint8Array([0xff, 0x01, 0x23, 0x45, 0x67, 0xff]);
  assertEquals(decodeUint32BE(storage.subarray(1, 5))[0], 0x0123_4567, "relative view");
  let threw = false;
  try {
    decodeUint32BE(new Uint8Array(5));
  } catch (error) {
    threw = error instanceof RangeError;
  }
  assertEquals(threw, true, "partial word");
});
