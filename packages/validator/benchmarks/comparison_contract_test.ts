import { booleanValidators, invalidInput, validInput } from "./_comparison.ts";

Deno.test("comparison schemas agree on the benchmark contract", () => {
  for (const [name, validate] of Object.entries(booleanValidators)) {
    if (!validate(validInput)) throw new Error(`${name} rejected the valid fixture`);
    if (validate(invalidInput)) throw new Error(`${name} accepted the invalid fixture`);
  }
});
