import { shapeScenarios } from "./_schema_shapes.ts";

let sink: unknown;

for (const scenario of shapeScenarios) {
  for (const validator of scenario.validators) {
    Deno.bench({ name: validator.name, group: `${scenario.name} / valid` }, () => {
      sink = validator.check(scenario.valid);
    });
    Deno.bench({ name: validator.name, group: `${scenario.name} / early invalid` }, () => {
      sink = validator.check(scenario.earlyInvalid);
    });
    Deno.bench({ name: validator.name, group: `${scenario.name} / late invalid` }, () => {
      sink = validator.check(scenario.lateInvalid);
    });
  }
}

globalThis.addEventListener("unload", () => {
  if (sink === Symbol.for("never")) console.log(sink);
});
