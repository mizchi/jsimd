import { accuracyCases, accuracyValidators } from "./_validator_only.ts";

Deno.test("validator-only implementations agree with every labeled case", () => {
  for (const validator of accuracyValidators) {
    let falsePositives = 0;
    let falseNegatives = 0;
    for (const fixture of accuracyCases) {
      const actual = validator.item(fixture.input);
      if (actual && !fixture.expected) falsePositives++;
      if (!actual && fixture.expected) falseNegatives++;
    }
    if (falsePositives !== 0 || falseNegatives !== 0) {
      throw new Error(
        `${validator.name}: ${falsePositives} false positives, ${falseNegatives} false negatives`,
      );
    }
  }
});
