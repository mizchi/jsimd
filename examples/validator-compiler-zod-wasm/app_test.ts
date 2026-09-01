import { instantiate } from "./generated/telemetry.js";

const bytes = await Deno.readFile(new URL("./generated/telemetry.wasm", import.meta.url));
const validator = instantiate(bytes);
const valid = Object.fromEntries(
  Array.from({ length: 32 }, (_, index) => [`value${index}`, index + 50]),
);

Deno.test("Zod subset compiles to a standalone Wasm SIMD validator", () => {
  if (!validator.is(valid)) throw new Error("valid telemetry was rejected");
  if (validator.is({ ...valid, value0: -1 })) throw new Error("minimum was not enforced");
  if (validator.is({ ...valid, value31: 132 })) throw new Error("maximum was not enforced");
  if (validator.is({ ...valid, value12: Number.NaN })) throw new Error("NaN was accepted");
  if (validator.is({ ...valid, extra: 1 })) throw new Error("unknown key was accepted");
});

Deno.test("Wasm glue rejects unsupported JavaScript shapes before numeric SIMD", () => {
  const { value31: _missing, ...missing } = valid;
  if (validator.is(missing)) throw new Error("missing field was accepted");
  if (validator.is({ ...valid, value8: "58" })) throw new Error("string coercion was accepted");
  if (validator.is(null)) throw new Error("null was accepted");
});
