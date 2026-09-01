import { is, string } from "../../src/scalar.ts";

document.body.textContent = String(is(string(), "valid"));
