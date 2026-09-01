import {
  array,
  boolean,
  compile,
  integer,
  is,
  maxValue,
  minLength,
  minValue,
  number,
  object,
  pipe,
  string,
} from "../src/scalar.ts";

const schema = object({
  name: pipe(string(), minLength(1)),
  age: pipe(number(), integer(), minValue(0), maxValue(130)),
  active: boolean(),
  tags: array(string()),
});
const compiled = compile(schema);
const inputs: readonly unknown[] = [
  { name: "Ada", age: 36, active: true, tags: ["compiler", "math"] },
  { name: "Grace", age: 85, active: false, tags: ["compiler"] },
  { name: "", age: 36, active: true, tags: [] },
  { name: "Linus", age: 56.5, active: true, tags: ["kernel"] },
];
let cursor = 0;
let sink = false;

Deno.bench("interpreted object validation", () => {
  sink = is(schema, inputs[cursor++ & 3]);
});

Deno.bench("compiled object validation", () => {
  sink = is(compiled, inputs[cursor++ & 3]);
});

globalThis.addEventListener("unload", () => {
  if (sink) console.log(sink);
});
