import * as v from "valibot";

const schema = v.object({
  name: v.pipe(v.string(), v.minLength(1)),
  age: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(130)),
  active: v.boolean(),
  tags: v.array(v.string()),
});

export const validate = (input: unknown): boolean => v.is(schema, input);
