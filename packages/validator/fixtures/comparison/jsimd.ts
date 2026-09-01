import {
  array,
  boolean,
  compile,
  integer,
  isCompiled,
  maxValue,
  minLength,
  minValue,
  number,
  object,
  pipe,
  string,
} from "../../src/scalar.ts";

const schema = compile(object({
  name: pipe(string(), minLength(1)),
  age: pipe(number(), integer(), minValue(0), maxValue(130)),
  active: boolean(),
  tags: array(string()),
}));

export const validate = (input: unknown): boolean => isCompiled(schema, input);
