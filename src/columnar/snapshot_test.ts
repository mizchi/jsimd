import { AdaptiveI32Column, AdaptiveU32Column, BitSlicedU8Column, SelectionMask } from "./mod.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${message}: expected ${right}, got ${left}`);
}

Deno.test("columnar adaptive i32 snapshot restores resident page encodings", () => {
  const values = new Int32Array(777);
  values.fill(-7, 0, 256);
  for (let index = 256; index < 512; index++) values[index] = 10_000 + (index & 255);
  for (let index = 512; index < values.length; index++) {
    values[index] = index & 1 ? -0x7000_0000 + index : 0x7000_0000 - index;
  }
  using source = AdaptiveI32Column.from(values);
  const snapshot = source.serialize();
  assert(
    snapshot.byteLength < values.byteLength,
    "adaptive i32 snapshot compresses clustered pages",
  );
  using restored = AdaptiveI32Column.fromSnapshot(snapshot);
  assertEquals(restored.encodingCounts(), source.encodingCounts(), "i32 encoding counts");
  using selected = new SelectionMask(values.length);
  restored.scanBetween(10_040, 10_090, selected);
  assertEquals(
    Array.from(selected.toIndices()),
    Array.from({ length: 50 }, (_, index) => index + 296),
    "i32 restored scan",
  );
  for (const index of [0, 255, 256, 511, 512, 776]) {
    assertEquals(restored.get(index), values[index], `i32 restored value ${index}`);
  }
});

Deno.test("columnar adaptive u32 snapshot preserves unsigned ordering", () => {
  const values = new Uint32Array(768);
  values.fill(0xffff_ff00, 0, 256);
  for (let index = 256; index < 512; index++) values[index] = 0x8000_0000 + (index & 255);
  for (let index = 512; index < 768; index++) {
    values[index] = index & 1 ? index : (0xffff_ffff - index) >>> 0;
  }
  using source = AdaptiveU32Column.from(values);
  const snapshot = source.serialize();
  using restored = AdaptiveU32Column.fromSnapshot(snapshot);
  using selected = new SelectionMask(values.length);
  restored.scanBetween(0x8000_0040, 0x8000_0090, selected);
  assertEquals(selected.countOnes(), 80, "u32 restored unsigned scan");
  assertEquals(restored.get(700), values[700], "u32 restored raw value");
});

Deno.test("columnar bit-sliced u8 snapshot preserves validity and planes", () => {
  const values = Uint8Array.from({ length: 517 }, (_, index) => index & 7);
  const validity = Uint8Array.from(
    { length: values.length },
    (_, index) => Number(index % 11 !== 0),
  );
  using source = BitSlicedU8Column.from(values, 3, validity);
  const snapshot = source.serialize();
  using restored = BitSlicedU8Column.fromSnapshot(snapshot);
  using selected = new SelectionMask(values.length);
  restored.scanEq(3, selected);
  let expected = 0;
  for (let index = 0; index < values.length; index++) {
    if (values[index] === 3 && validity[index] !== 0) expected++;
  }
  assertEquals(selected.countOnes(), expected, "u8 restored equality");
  assertEquals(restored.get(0), undefined, "u8 restored null");
  assertEquals(restored.get(3), 3, "u8 restored value");
});

Deno.test("columnar snapshots reject corrupt metadata without leaking allocations", () => {
  using source = AdaptiveI32Column.from(Int32Array.from({ length: 300 }, (_, index) => index));
  const snapshot = source.serialize();
  const before = AdaptiveI32Column.allocatorStats();
  const corrupt = snapshot.slice();
  // First page metadata begins after the 32-byte envelope for two shape fields/two payloads.
  new DataView(corrupt.buffer).setUint32(32, 0xffff_ffff, true);
  let rejected = false;
  try {
    AdaptiveI32Column.fromSnapshot(corrupt);
  } catch {
    rejected = true;
  }
  assert(rejected, "corrupt adaptive metadata rejected");
  const after = AdaptiveI32Column.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "failed restore allocations");
  assertEquals(after.liveBytes, before.liveBytes, "failed restore bytes");
});

Deno.test("columnar snapshots gather selected values without point calls", () => {
  const i32Values = Int32Array.from({ length: 777 }, (_, index) => {
    if (index < 256) return -5;
    if (index < 512) return 2_000 + (index & 255);
    return index & 1 ? -0x7000_0000 + index : 0x7000_0000 - index;
  });
  using i32Source = AdaptiveI32Column.from(i32Values);
  using i32Column = AdaptiveI32Column.fromSnapshot(i32Source.serialize());
  using selected = new SelectionMask(i32Values.length);
  i32Column.scanBetween(2_040, 2_090, selected);
  const i32Output = new Int32Array(selected.countOnes());
  assertEquals(i32Column.gatherInto(selected, i32Output), 50, "i32 gathered count");
  assertEquals(Array.from(i32Output), Array.from(i32Values.slice(296, 346)), "i32 gathered values");

  const u32Values = Uint32Array.from({ length: 777 }, (_, index) => 0x8000_0000 + index);
  using u32Source = AdaptiveU32Column.from(u32Values);
  using u32Column = AdaptiveU32Column.fromSnapshot(u32Source.serialize());
  u32Column.scanBetween(0x8000_0040, 0x8000_0090, selected);
  const u32Output = new Uint32Array(80);
  assertEquals(u32Column.gatherInto(selected, u32Output), 80, "u32 gathered count");
  assertEquals(Array.from(u32Output), Array.from(u32Values.slice(64, 144)), "u32 gathered values");

  const u8Values = Uint8Array.from({ length: 777 }, (_, index) => index & 7);
  const validity = Uint8Array.from({ length: 777 }, (_, index) => Number(index % 11 !== 0));
  using u8Column = BitSlicedU8Column.from(u8Values, 3, validity);
  selected.fill();
  const u8Output = new Uint8Array(777);
  const validOutput = new Uint8Array(777);
  assertEquals(u8Column.gatherInto(selected, u8Output, validOutput), 777, "u8 gathered count");
  assertEquals(
    Array.from(u8Output),
    Array.from(u8Values, (value, index) => validity[index] ? value : 0),
    "u8 gathered values",
  );
  assertEquals(Array.from(validOutput), Array.from(validity), "u8 gathered validity");
});
