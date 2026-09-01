import {
  compileSimd,
  float32Array,
  float64Array,
  int32Array,
  maxValue,
  minValue,
  type SimdNumericArray,
  type SimdValidator,
} from "../src/mod.ts";

const minimum = -1_000;
const maximum = 1_000;
let sink = 0;

registerRangeBenchmarks(
  "i32",
  await compileSimd(int32Array(minValue(minimum), maxValue(maximum))),
  (length) => new Int32Array(length).fill(maximum),
);
registerRangeBenchmarks(
  "f32",
  await compileSimd(float32Array(minValue(minimum), maxValue(maximum))),
  (length) => new Float32Array(length).fill(maximum),
);
registerRangeBenchmarks(
  "f64",
  await compileSimd(float64Array(minValue(minimum), maxValue(maximum))),
  (length) => new Float64Array(length).fill(maximum),
);

function registerRangeBenchmarks<Output extends SimdNumericArray>(
  kind: string,
  validator: SimdValidator<Output>,
  createInput: (length: number) => Output,
): void {
  validator.resident(65_536); // Grow once before benchmark views are created.
  for (const length of [32, 1_024, 65_536]) {
    const input = createInput(length);
    input[length - 1] = maximum + 1;
    const resident = validator.resident(length);
    resident.input.set(input);
    const group = `${kind} range / ${length} elements / invalid last`;

    Deno.bench({ name: "JavaScript scalar", group, baseline: true }, () => {
      sink = scalarFirstInvalid(input, minimum, maximum);
    });
    Deno.bench({ name: "Wasm SIMD copy-inclusive", group }, () => {
      sink = validator.firstInvalid(input);
    });
    Deno.bench({ name: "Wasm SIMD resident", group }, () => {
      sink = resident.firstInvalid();
    });
  }
}

function scalarFirstInvalid(input: SimdNumericArray, lower: number, upper: number): number {
  for (let index = 0; index < input.length; index++) {
    const value = input[index];
    if (!Number.isFinite(value) || value < lower || value > upper) return index;
  }
  return -1;
}

globalThis.addEventListener("unload", () => {
  if (sink === -2) console.log(sink);
});
