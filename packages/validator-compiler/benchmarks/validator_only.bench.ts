import {
  booleanValidators,
  diagnosticValidators,
  earlyInvalidItem,
  lateInvalidItem,
  lateInvalidList,
  validItem,
  validList,
} from "./_validator_only.ts";

let sink: unknown;

for (const validator of booleanValidators) {
  Deno.bench({ name: validator.name, group: "item valid / boolean" }, () => {
    sink = validator.item(validItem);
  });
  Deno.bench({ name: validator.name, group: "item early invalid / boolean" }, () => {
    sink = validator.item(earlyInvalidItem);
  });
  Deno.bench({ name: validator.name, group: "item late invalid / boolean" }, () => {
    sink = validator.item(lateInvalidItem);
  });
  Deno.bench({ name: validator.name, group: "128 items valid / boolean" }, () => {
    sink = validator.list(validList);
  });
  Deno.bench({ name: validator.name, group: "128 items late invalid / boolean" }, () => {
    sink = validator.list(lateInvalidList);
  });
}

for (const validator of diagnosticValidators) {
  Deno.bench({ name: validator.name, group: "item valid / diagnostic" }, () => {
    sink = validator.validate(validItem);
  });
  Deno.bench({ name: validator.name, group: "item late invalid / diagnostic" }, () => {
    sink = validator.validate(lateInvalidItem);
  });
}

globalThis.addEventListener("unload", () => {
  if (sink === Symbol.for("never")) console.log(sink);
});
