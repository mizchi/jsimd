import * as z from "zod/mini";

const schema = z.compile(z.object({
  name: z.string().check(z.minLength(1)),
  age: z.number().check(z.int(), z.minimum(0), z.maximum(130)),
  active: z.boolean(),
  tags: z.array(z.string()),
}));

export const validate = (input: unknown): boolean => z.safeParse(schema, input).success;
