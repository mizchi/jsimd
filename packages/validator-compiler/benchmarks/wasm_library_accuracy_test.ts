import { strictNumericComparison } from "./_wasm_library_comparison.ts";

const scenario = await strictNumericComparison(32);

Deno.test("wide numeric comparison validators agree on the supported Wasm subset", () => {
  const cases: readonly [string, unknown, boolean][] = [
    ["valid", scenario.valid, true],
    ["all lower bounds", scenario.lowerBounds, true],
    ["all upper bounds", scenario.upperBounds, true],
    ["early invalid", scenario.earlyInvalid, false],
    ["late invalid", scenario.lateInvalid, false],
    ["wrong type", { ...scenario.valid, value15: "65" }, false],
    ["NaN", { ...scenario.valid, value15: Number.NaN }, false],
    ["positive infinity", { ...scenario.valid, value15: Number.POSITIVE_INFINITY }, false],
    ["negative infinity", { ...scenario.valid, value15: Number.NEGATIVE_INFINITY }, false],
    ["missing field", omit(scenario.valid, "value15"), false],
    ["unknown field", { ...scenario.valid, extra: true }, false],
    ["null", null, false],
    ["array", Object.values(scenario.valid), false],
  ];

  for (const validator of scenario.validators) {
    for (const [name, input, expected] of cases) {
      const actual = validator.check(input);
      if (actual !== expected) {
        throw new Error(`${validator.name}: ${name}: expected ${expected}, got ${actual}`);
      }
    }
  }
});

function omit(value: Record<string, number>, key: string): Record<string, number> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}
