import { type } from "arktype";

const schema = type({
  name: "string >= 1",
  age: "0 <= number.integer <= 130",
  active: "boolean",
  tags: "string[]",
});

export const validate = (input: unknown): boolean => schema.allows(input);
