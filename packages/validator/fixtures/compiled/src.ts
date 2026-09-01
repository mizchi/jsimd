import {
  compile,
  integer,
  maxValue,
  minLength,
  minValue,
  number,
  object,
  optional,
  pipe,
  safeParse,
  string,
} from "../../src/scalar.ts";

const user = compile(object({
  name: pipe(string(), minLength(1)),
  age: pipe(number(), integer(), minValue(0), maxValue(130)),
  nickname: optional(string()),
}));

document.body.textContent = String(safeParse(user, { name: "Ada", age: 36 }).success);
