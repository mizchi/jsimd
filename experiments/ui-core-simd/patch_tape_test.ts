import {
  applyPatchBatch,
  applyTextI32Batch,
  NumericPatchTape,
  type PatchBinding,
  type PatchTarget,
} from "./patch_tape.ts";

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${message}: expected ${right}, got ${left}`);
}

const bindings: readonly PatchBinding[] = [
  { kind: "text-i32", target: 0 },
  { kind: "boolean-property", target: 1, name: "disabled" },
  { kind: "style-f32", target: 2, name: "opacity" },
  { kind: "text-i32", target: 3 },
  { kind: "boolean-property", target: 4, name: "hidden" },
];

Deno.test("NumericPatchTape emits an initial batch and then only changed lanes", async () => {
  const tape = await NumericPatchTape.create(bindings);
  tape.i32Values[0] = 12;
  tape.setBoolean(1, true);
  tape.f32Values[2] = 0.5;
  tape.setI32(3, -7);
  tape.setBoolean(4, false);

  const initial = tape.drain();
  assertEquals([...initial.bindingIds], [0, 1, 2, 3, 4], "initial IDs");
  assertEquals(initial.values[0], 12, "initial integer bits");
  assertEquals(initial.values[1], 1, "initial boolean bits");
  assertEquals(initial.f32Values[2], 0.5, "initial float bits");
  assertEquals(tape.lastStrategy, "simd", "Wasm path used");
  assertEquals(tape.drain().bindingIds.length, 0, "stable values skipped");

  tape.setI32(0, 12);
  tape.setBoolean(1, false);
  tape.setF32(2, 0.25);
  tape.setI32(3, -8);
  const changed = tape.drain();
  assertEquals([...changed.bindingIds], [1, 2, 3], "changed IDs");
  assertEquals([...changed.values].map((value) => value | 0), [0, 1048576000, -8], "raw values");
  assertEquals([...changed.f32Values], [0, 0.25, Number.NaN], "float projection");
});

Deno.test("applyPatchBatch applies typed commands through the static binding table", async () => {
  const text = { data: "" };
  const button = { disabled: false };
  const styleWrites: Array<[string, string]> = [];
  const panel = {
    style: {
      setProperty(name: string, value: string) {
        styleWrites.push([name, value]);
      },
    },
  };
  const otherText = { data: "" };
  const section = { hidden: true };
  const targets: readonly PatchTarget[] = [text, button, panel, otherText, section];
  const tape = await NumericPatchTape.create(bindings, { wasm: false });
  tape.setI32(0, 42);
  tape.setBoolean(1, true);
  tape.setF32(2, 0.75);
  tape.setI32(3, -3);
  tape.setBoolean(4, false);

  const count = applyPatchBatch(tape.drain(), bindings, targets);

  assertEquals(count, 5, "applied count");
  assertEquals(text.data, "42", "text command");
  assertEquals(button.disabled, true, "boolean property command");
  assertEquals(styleWrites, [["opacity", "0.75"]], "style command");
  assertEquals(otherText.data, "-3", "tail text command");
  assertEquals(section.hidden, false, "tail boolean command");
  assertEquals(tape.lastStrategy, "scalar", "fallback path used");
});

Deno.test("applyTextI32Batch uses binding IDs as direct text-target indices", async () => {
  const textBindings: PatchBinding[] = Array.from(
    { length: 5 },
    (_, target) => ({ kind: "text-i32", target }),
  );
  const targets = Array.from({ length: 5 }, () => ({ data: "" }));
  const tape = await NumericPatchTape.create(textBindings);
  tape.i32Values.set([10, 20, 30, 40, 50]);
  applyTextI32Batch(tape.drain(), targets);
  tape.i32Values[1] = 21;
  tape.i32Values[4] = 51;

  const count = applyTextI32Batch(tape.drain(), targets);

  assertEquals(count, 2, "specialized applied count");
  assertEquals(targets.map((target) => target.data), ["10", "21", "30", "40", "51"], "text");
});

Deno.test("NumericPatchTape validates writes and target tables", async () => {
  const tape = await NumericPatchTape.create([{ kind: "text-i32", target: 0 }]);
  let writeFailed = false;
  try {
    tape.setI32(1, 0);
  } catch (error) {
    writeFailed = error instanceof RangeError;
  }
  assertEquals(writeFailed, true, "binding bounds checked");

  const batch = tape.drain();
  let targetFailed = false;
  try {
    applyPatchBatch(batch, [{ kind: "text-i32", target: 1 }], [{}]);
  } catch (error) {
    targetFailed = error instanceof RangeError;
  }
  assertEquals(targetFailed, true, "target bounds checked");
});

Deno.test("SIMD and scalar tapes agree across full vectors and scalar tails", async () => {
  let random = 0x1234_5678;
  const next = () => {
    random ^= random << 13;
    random ^= random >>> 17;
    random ^= random << 5;
    return random | 0;
  };
  for (const count of [0, 1, 3, 4, 5, 16, 65, 128]) {
    const localBindings: PatchBinding[] = Array.from(
      { length: count },
      (_, target) => ({ kind: "text-i32", target }),
    );
    const simd = await NumericPatchTape.create(localBindings);
    const scalar = await NumericPatchTape.create(localBindings, { wasm: false });
    for (let bindingId = 0; bindingId < count; bindingId++) {
      const value = next();
      simd.i32Values[bindingId] = value;
      scalar.i32Values[bindingId] = value;
    }
    for (let round = 0; round < 12; round++) {
      const stride = round % 3 === 0 ? 1 : round % 3 === 1 ? 4 : 17;
      for (let bindingId = round % Math.max(1, stride); bindingId < count; bindingId += stride) {
        const value = next();
        simd.i32Values[bindingId] = value;
        scalar.i32Values[bindingId] = value;
      }
      const simdBatch = simd.drain();
      const ids = [...simdBatch.bindingIds];
      const values = [...simdBatch.values];
      const scalarBatch = scalar.drain();
      assertEquals(ids, [...scalarBatch.bindingIds], `IDs for count ${count}, round ${round}`);
      assertEquals(values, [...scalarBatch.values], `values for count ${count}, round ${round}`);
    }
  }
});
