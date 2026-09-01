import { readFile } from "node:fs/promises";
import { instantiate, type Output as Telemetry } from "./generated/telemetry.js";

const bytes = await readFile(new URL("./generated/telemetry.wasm", import.meta.url));
const validator = instantiate(bytes);
const telemetry = Object.fromEntries(
  Array.from({ length: 32 }, (_, index) => [`value${index}`, index + 50]),
) as Telemetry;

if (!validator.is(telemetry)) throw new Error("generated Wasm rejected valid telemetry");
if (validator.is({ ...telemetry, value31: 132 })) {
  throw new Error("generated Wasm accepted an out-of-range metric");
}

console.log("valid telemetry", telemetry.value0, telemetry.value31);
