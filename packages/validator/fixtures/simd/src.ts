import { compileSimd, int32Array, maxValue, minValue } from "../../src/mod.ts";

const validator = await compileSimd(int32Array(minValue(0), maxValue(130)));
document.querySelector("#app")!.textContent = String(validator.is(new Int32Array([36])));
