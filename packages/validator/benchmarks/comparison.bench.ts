import {
  booleanValidators,
  diagnosticValidators,
  invalidInput,
  validInput,
} from "./_comparison.ts";

let sink: unknown;

for (const [name, validate] of Object.entries(booleanValidators)) {
  Deno.bench({ name, group: "object valid / boolean" }, () => {
    sink = validate(validInput);
  });
  Deno.bench({ name, group: "object invalid / boolean" }, () => {
    sink = validate(invalidInput);
  });
}

for (const [name, validate] of Object.entries(diagnosticValidators)) {
  Deno.bench({ name, group: "object invalid / diagnostic" }, () => {
    sink = validate(invalidInput);
  });
}

globalThis.addEventListener("unload", () => {
  if (sink === Symbol.for("never")) console.log(sink);
});
