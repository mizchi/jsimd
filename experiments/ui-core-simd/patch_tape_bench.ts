import { NumericPatchTape, type PatchBinding } from "./patch_tape.ts";

for (const count of [4_096, 65_536]) {
  const bindings: PatchBinding[] = Array.from(
    { length: count },
    (_, target) => ({ kind: "text-i32", target }),
  );
  for (const [label, stride] of [["1.6%", 64], ["25%", 4], ["100%", 1]] as const) {
    const simd = await NumericPatchTape.create(bindings);
    const scalar = await NumericPatchTape.create(bindings, { wasm: false });
    simd.drain();
    scalar.drain();
    let simdTick = 0;
    let scalarTick = 0;
    const expected = Math.ceil(count / stride);

    Deno.bench(`patch tape SIMD ${count} bindings / ${label} changed`, () => {
      simdTick++;
      for (let bindingId = 0; bindingId < count; bindingId += stride) {
        simd.i32Values[bindingId] = simdTick + bindingId;
      }
      if (simd.drain().bindingIds.length !== expected) throw new Error("unexpected SIMD batch");
    });

    Deno.bench(`patch tape scalar ${count} bindings / ${label} changed`, () => {
      scalarTick++;
      for (let bindingId = 0; bindingId < count; bindingId += stride) {
        scalar.i32Values[bindingId] = scalarTick + bindingId;
      }
      if (scalar.drain().bindingIds.length !== expected) throw new Error("unexpected scalar batch");
    });
  }
}
