import { AdaptiveI32Column } from "@mizchi/jsimd/columnar";
import { parseAdaptiveI32Snapshot, SharedI32PageEncoding } from "./adaptive_i32_snapshot.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("parseAdaptiveI32Snapshot preserves constant, FOR, and raw physical pages", () => {
  const values = new Int32Array(768);
  values.fill(-7, 0, 256);
  for (let index = 256; index < 512; index++) values[index] = 1_000 + (index & 255);
  for (let index = 512; index < 768; index++) {
    values[index] = index & 1 ? 0x7000_0000 - index : -0x7000_0000 + index;
  }
  using column = AdaptiveI32Column.from(values);
  const parsed = parseAdaptiveI32Snapshot(column.serialize());

  assert(parsed.length === values.length, "logical length");
  assert(parsed.pages.length === 3, "physical page count");
  assert(
    parsed.pages[0]!.encoding === SharedI32PageEncoding.Constant &&
      parsed.pages[0]!.minimum === -7 && parsed.pages[0]!.payload.byteLength === 0,
    "constant page",
  );
  assert(
    parsed.pages[1]!.encoding === SharedI32PageEncoding.FrameOfReference &&
      parsed.pages[1]!.bitWidth === 8,
    "FOR page",
  );
  assert(parsed.pages[2]!.encoding === SharedI32PageEncoding.Raw, "raw page");
  assert(
    column.encodingCounts().frameOfReference === 1,
    "fixture contains one FOR page",
  );
  assert(parsed.payloadBytes < values.byteLength, "compressed payload is smaller than raw input");
});

Deno.test("parseAdaptiveI32Snapshot rejects corrupt metadata without resident reconstruction", () => {
  using column = AdaptiveI32Column.from(Int32Array.from({ length: 256 }, (_, index) => index));
  const corrupt = column.serialize();
  // The first adaptive page header starts at byte 32. Change its logical length.
  new DataView(corrupt.buffer, corrupt.byteOffset, corrupt.byteLength).setUint16(32, 255, true);
  let threw = false;
  try {
    parseAdaptiveI32Snapshot(corrupt);
  } catch (error) {
    threw = error instanceof RangeError && error.message.includes("snapshot");
  }
  assert(threw, "corrupt adaptive metadata rejects");
});
