import { shapeScenarios } from "./_schema_shapes.ts";

Deno.test("string, nested object, and array validators agree on labeled cases", () => {
  for (const scenario of shapeScenarios) {
    for (const validator of scenario.validators) {
      let falsePositives = 0;
      let falseNegatives = 0;
      for (const fixture of scenario.accuracyCases) {
        const actual = validator.check(fixture.input);
        if (actual && !fixture.expected) falsePositives++;
        if (!actual && fixture.expected) falseNegatives++;
      }
      if (falsePositives !== 0 || falseNegatives !== 0) {
        throw new Error(
          `${scenario.name}/${validator.name}: ` +
            `${falsePositives} false positives, ${falseNegatives} false negatives`,
        );
      }
    }
  }
});
