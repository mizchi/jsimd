const schema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    age: { type: "integer", minimum: 0, maximum: 130 },
  },
  required: ["name", "age"],
  additionalProperties: false,
};

export const User = {
  "~standard": {
    version: 1,
    vendor: "fixture",
    validate: (value) => ({ value }),
    jsonSchema: {
      input: () => schema,
      output: () => schema,
    },
  },
};

export const WideMetrics = {
  type: "object",
  properties: Object.fromEntries(
    Array.from({ length: 32 }, (_, index) => [
      `value${index}`,
      { type: "number", minimum: index, maximum: index + 100 },
    ]),
  ),
  required: Array.from({ length: 32 }, (_, index) => `value${index}`),
  additionalProperties: false,
};
